// SAP supplies assignable shipments. Firestore supplies the assigned delivery lifecycle.
// This projection is for display; it never writes back to either source.
export function mergeAssignmentGroups(sapGroups, assignments) {
    const groups = Object.assign(Object.create(null), sapGroups);
    for (const [key, assignment] of Object.entries(assignments)) {
        const sapRows = groups[key] || [];
        const storedRows = (assignment.lineItems || [])
            .map(line => {
                const sapRow = sapRows.find(row => String(row.OBDNumber || '') === String(line.obdNumber || '')) || {};
                return {
                ...sapRow,
                SAPDispatchNumber: key,
                OBDNumber: String(line.obdNumber || ''),
                ShipToPartyName: line.customerName ?? sapRow.ShipToPartyName ?? '',
                ShipToParty: line.shipToParty ?? sapRow.ShipToParty ?? '',
                Address: line.address ?? sapRow.Address ?? '',
                ActualDelDate: line.actualDelDate ?? sapRow.ActualDelDate ?? '',
                PlanningDate: line.planningDate ?? sapRow.PlanningDate ?? '',
                Quantity: line.quantity ?? line.quantityNumeric ?? sapRow.Quantity,
                Volume: line.volume ?? sapRow.Volume,
                Weight: line.weight ?? sapRow.Weight,
                Amount: line.amount ?? sapRow.Amount,
                TruckType: assignment.truckType ?? sapRow.TruckType ?? '',
                PlateNumber: assignment.truckPlate ?? sapRow.PlateNumber ?? '',
                Driver: assignment.driverName ?? sapRow.Driver ?? '',
                Route: assignment.route ?? sapRow.Route ?? '',
                };
            });
        // Stored line items are the canonical assigned cargo, including repeated OBD rows.
        if (storedRows.length) groups[key] = storedRows;
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
