const axios = require('axios');
const ALLOWED_TYPES = new Set(['auv','4w','6w','10w','20f','40f']);
const TEMPORARY_REVIEW_DISPATCH = '0010139586';
const FIELDS = ['TrId','PlanningDate','ActualDelDate','PlanningRemarks','PONumber','SONumber','OBDNumber','OBDItem',
    'DocumentNumber','SoldToParty','ShipToPartyName','Route','Amount','Volume','Weight','Quantity','Tdn','TruckType',
    'SAPDispatchNumber','DonePicking','PgiStatus','CheckStatus','ShipToParty','Address','PlateNumber','ForwardingAgent',
    'Driver','PrintedDocument','ShipmentStart','Longitude','Latitude','Delivery'];
let cache, pending;

function isUnassigned(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    // Temporary owner review exception; the blank truck type still fails assignment validation.
    if (row.SAPDispatchNumber === TEMPORARY_REVIEW_DISPATCH) return true;
    const driver = row.Driver;
    if (driver != null && typeof driver !== 'string') return false;
    return (!driver || driver.includes('-') || driver.includes('*-*') || driver.trim().toLowerCase() === 'driver')
        && typeof row.TruckType === 'string' && ALLOWED_TYPES.has(row.TruckType.trim().toLowerCase())
        && row.Delivery !== 'DELIVERED'
        && typeof row.PgiStatus === 'string' && row.PgiStatus.trim().toLowerCase() === 'x'
        && typeof row.SAPDispatchNumber === 'string' && Boolean(row.SAPDispatchNumber.trim())
        && (driver || '').trim().toUpperCase() !== 'FOR RE-SO';
}

async function read({maxAge=60000}={}) {
    if (cache && Date.now()-cache.fetchedAt < maxAge) return {...cache,cached:true};
    if (!pending) {
        pending = (async()=>{
            if (!process.env.SAP_URL) throw new Error('Missing SAP source configuration');
            const response = await axios.get(process.env.SAP_URL,{timeout:20000,maxContentLength:50*1024*1024,
                headers:{Accept:'application/json'}});
            const payload = response.data;
            const rows = Array.isArray(payload) ? payload : payload?.d?.results || payload?.results;
            if (!Array.isArray(rows) || rows.length > 100000) throw new Error('Invalid or excessive SAP response');
            const filtered = rows.filter(isUnassigned).map(row => Object.freeze(Object.fromEntries(
                FIELDS.filter(key=>row[key] === null || ['string','number','boolean'].includes(typeof row[key]))
                    .map(key=>[key,row[key]]))));
            cache = {rows:Object.freeze(filtered), fetchedAt:Date.now()};
            return {...cache,cached:false};
        })().catch(()=>{throw Object.assign(new Error('SAP temporarily unavailable'),{statusCode:503});})
            .finally(()=>{pending=undefined;});
    }
    return pending;
}

module.exports = {read,isUnassigned};
