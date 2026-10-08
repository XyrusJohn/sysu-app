function conflict(code,message) {return {status:409,code,message};}
function validateAssignment(rows,body) {
    const group=rows.filter(row=>row.SAPDispatchNumber.trim()===body.dispatchKey);
    if (!group.length) return conflict('SAP_DISPATCH_UNAVAILABLE','Dispatch is no longer unassigned in SAP. Refresh shipments.');
    // Matches the current group contract: TruckType comes from the first eligible dispatch row.
    if (group[0].TruckType.trim().toLowerCase()!==body.truckType.trim().toLowerCase()) {
        return conflict('SAP_TRUCK_TYPE_MISMATCH','Truck type does not match the SAP dispatch.');
    }
    const canonical=[];
    for(const row of group) {
        const quantity=Number(row.Quantity);
        const customer=(row.ShipToPartyName || row.ShipToParty || '').trim();
        if (typeof row.OBDNumber!=='string' || !row.OBDNumber.trim() || row.OBDNumber.length>128
            || row.OBDNumber.includes('/') || !customer || customer.length>500
            || typeof row.Quantity!=='string' || !/^\d+(?:\.\d+)?$/.test(row.Quantity)
            || !Number.isFinite(quantity) || quantity<=0 || quantity>Number.MAX_SAFE_INTEGER) {
            return conflict('SAP_DATA_INVALID','Dispatch contains incomplete SAP line items and requires reconciliation.');
        }
        canonical.push({obdNumber:row.OBDNumber,quantity,customerName:customer});
    }
    if (canonical.length>500 || canonical.length!==body.lineItems.length) {
        return conflict('SAP_LINE_ITEMS_MISMATCH','Assignment must contain every eligible row of the SAP dispatch.');
    }
    const key=item=>JSON.stringify([item.obdNumber,item.quantity,item.customerName]);
    const counts=new Map();
    for(const item of canonical) counts.set(key(item),(counts.get(key(item))||0)+1);
    for(const item of body.lineItems) {
        const id=key(item),count=counts.get(id)||0;
        if (!count) return conflict('SAP_LINE_ITEMS_MISMATCH','OBD, quantity or customer does not match SAP. Refresh shipments.');
        counts.set(id,count-1);
    }
    return {status:200,lineItems:canonical};
}
module.exports={validateAssignment};
