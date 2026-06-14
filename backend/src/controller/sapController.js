const axios = require("axios");

let sapCache = {data: null, timestamp: 0};
const CACHE_TTL = 60000;

exports.getSapData = async (req, res) => {
    const now = Date.now();
    const sapUrl = process.env.SAP_URL;

    if (sapCache.data && now - sapCache.timestamp < CACHE_TTL) {
        return res.json({
            success: true,
            data: sapCache.data,
            cached: true,
            cachedAt: new Date(sapCache.timestamp).toISOString(),
        });
    }

    try {
        if (!sapUrl) throw new Error("SAP_URL environment variable is not set");

        const response = await axios.get(sapUrl, {
            timeout: 15000,
            headers: {Accept: "application/json"},
        });

        const result = response.data;
        sapCache = {data: result, timestamp: now};

        res.json({
            success: true,
            data: result,
            cached: false,
            fetchedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error("SAP fetch error:", error.message);
        res.status(500).json({
            success: false,
            error: "Failed to fetch data from SAP",
            // Do not expose error.message to client — it may contain internal paths / hostnames
        });
    }
};
