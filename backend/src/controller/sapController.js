const sapSource = require('../services/sapSource');

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
