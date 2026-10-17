const sapSource = require('../services/sapSource');
const {admin} = require('../config/firebase');
const {z} = require('zod');

const dispatchDetailsRequest = z.object({
    dispatchKeys: z.array(z.string().min(1).max(64).refine(value => value === value.trim()
        && !value.includes('/') && value !== '.' && value !== '..'
        && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'Invalid dispatch identifier'))
        .min(1).max(100),
});

exports.getSapData = async (_req,res) => {
    try {
        const snapshot = await sapSource.read();
        return res.json({success:true,data:{d:{results:snapshot.rows}},cached:snapshot.cached,
            fetchedAt:new Date(snapshot.fetchedAt).toISOString()});
    } catch {
        console.error(JSON.stringify({event:'sap_unavailable'}));
        return res.status(503).json({success:false,error:'SAP temporarily unavailable'});
    }
};

exports.getAssignedDispatchDetails = async (req,res) => {
    const parsed = dispatchDetailsRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({success:false,error:'Invalid dispatch details request'});
    res.set('Cache-Control','no-store');

    try {
        const keys = [...new Set(parsed.data.dispatchKeys)];
        const db = admin.firestore();
        const snapshots = await Promise.all(keys.map(key => db.collection('sap_assignments').doc(key).get()));
        const allowedObds = new Map();
        snapshots.forEach((snapshot,index) => {
            if (!snapshot.exists) return;
            const lineItems = snapshot.data()?.lineItems;
            const obds = Array.isArray(lineItems) ? lineItems.map(line => line?.obdNumber)
                .filter(value => typeof value === 'string' && value.length > 0) : [];
            if (obds.length) allowedObds.set(keys[index], new Set(obds));
        });
        if (!allowedObds.size) return res.json({success:true,data:{}});

        const sapDetails = await sapSource.readDispatchDetails([...allowedObds.keys()]);
        const data = Object.create(null);
        for (const [key,obds] of allowedObds) {
            data[key] = (sapDetails[key] || []).filter(row => obds.has(String(row.OBDNumber || '')));
        }
        return res.json({success:true,data});
    } catch {
        console.error(JSON.stringify({event:'sap_dispatch_details_unavailable'}));
        return res.status(503).json({success:false,error:'SAP temporarily unavailable'});
    }
};
