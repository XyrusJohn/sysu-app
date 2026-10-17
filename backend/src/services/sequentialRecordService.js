// A shared sequence document serializes writers. Existing records seed the
// sequence once; create-only persistence also protects against legacy imports.
async function createSequentialRecord(db, collectionName, format, parse, build) {
    const collection = db.collection(collectionName);
    const sequence = db.collection('id_sequences').doc(collectionName);
    let legacyMaximum = 0;
    if (!(await sequence.get()).exists) {
        const legacy = await collection.get();
        for (const doc of legacy.docs) {
            const value = parse(doc.id);
            if (value !== null) legacyMaximum = Math.max(legacyMaximum, value);
        }
    }
    return db.runTransaction(async tx => {
        const counter = await tx.get(sequence);
        let maximum = counter.exists ? counter.data().maximum : legacyMaximum;
        if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid ID sequence');
        let id, ref;
        // All reads occur before any write. Collision checks prevent overwriting
        // records created by older writers/imports outside this allocator.
        for (let attempt = 0; attempt < 100; attempt++) {
            maximum++;
            if (!Number.isSafeInteger(maximum)) throw new Error('ID sequence exhausted');
            id = format(maximum);
            ref = collection.doc(id);
            if (!(await tx.get(ref)).exists) {
                const record = build(id);
                tx.create(ref, record);
                tx.set(sequence, {maximum});
                return {id, ...record};
            }
        }
        throw new Error('ID sequence collision limit exceeded');
    }, {maxAttempts: 10});
}

async function deleteSequentialRecord(db, collectionName, id, parse) {
    const collection = db.collection(collectionName);
    const sequence = db.collection('id_sequences').doc(collectionName);
    const recordRef = collection.doc(id);

    return db.runTransaction(async tx => {
        const records = await tx.get(collection);
        const sequenceSnapshot = await tx.get(sequence);
        const record = await tx.get(recordRef);
        if (!record.exists) return false;

        let maximum = sequenceSnapshot.exists ? sequenceSnapshot.data().maximum : 0;
        for (const existing of records.docs) {
            const value = parse(existing.id);
            if (value !== null) maximum = Math.max(maximum, value);
        }
        const deletedValue = parse(id);
        if (deletedValue !== null) maximum = Math.max(maximum, deletedValue);

        tx.delete(recordRef);
        tx.set(sequence, {maximum});
        return true;
    }, {maxAttempts: 10});
}

module.exports = {createSequentialRecord, deleteSequentialRecord};
