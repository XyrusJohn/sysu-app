// SAP supplies assignable shipments. Firestore supplies the assigned delivery lifecycle.
// This projection is for display; it never writes back to either source.
export function mergeAssignmentGroups(sapGroups, assignments) {
    const groups = Object.assign(Object.create(null), sapGroups);
    for (const [key, assignment] of Object.entries(assignments)) {
        const sapRows = groups[key] || [];
        const sapObds = new Set(sapRows.map(row => String(row.OBDNumber || '')));
        const storedRows = (assignment.lineItems || [])
            .filter(line => !sapObds.has(String(line.obdNumber || '')))
            .map(line => ({
                SAPDispatchNumber: key,
                OBDNumber: String(line.obdNumber || ''),
                ShipToPartyName: line.customerName || '',
                ShipToParty: line.shipToParty || '',
                Address: line.address || '',
                ActualDelDate: line.actualDelDate || '',
                PlanningDate: line.planningDate || '',
                Quantity: line.quantity ?? line.quantityNumeric,
                Volume: line.volume,
                Weight: line.weight,
                Amount: line.amount,
                TruckType: assignment.truckType || '',
                PlateNumber: assignment.truckPlate || '',
                Driver: assignment.driverName || '',
                Route: assignment.route || '',
            }));
        if (sapRows.length || storedRows.length) groups[key] = [...sapRows, ...storedRows];
    }
    return groups;
}

export function isDeliveredAssignment(assignment) {
    const status = (assignment?.tripStatus || '').trim().toLowerCase();
    return status === 'completed' || (status === 'returning_to_base'
        && assignment.lineItems?.length > 0
        && assignment.lineItems.every(line => line.isPodCompleted === true));
}

export function assignmentDisplayStatus(assignment, sapRow) {
    const status = (assignment?.tripStatus || '').trim().toLowerCase();
    if (status === 'returning_to_base' && isDeliveredAssignment(assignment)) return 'Delivered / Returning to base';
    if (status === 'completed') return 'Delivered';
    return status ? status.replaceAll('_', ' ') : sapRow.PgiStatus || sapRow.CheckStatus || 'Pending';
}
