require('dotenv').config();
const express = require('express');
const sharp = require('sharp');
const DigestFetch = require('digest-fetch');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const app = express();

const PORT = process.env.PORT || 3000;
const NVR_IP = process.env.NVR_IP;
const USERNAME = process.env.NVR_USERNAME;
const PASSWORD = process.env.NVR_PASSWORD;

const channels = process.env.CHANNELS
    ? process.env.CHANNELS.split(',').map(ch => parseInt(ch.trim(), 10))
    : [];

if (!NVR_IP || !USERNAME || !PASSWORD || channels.length === 0) {
    console.error('Missing required environment configuration variables.');
    process.exit(1);
}

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// --- HELPER FUNCTIONS ---

async function getChannelSnapshot(client, channel) {
    try {
        const imgResponse = await client.fetch(
            `http://${NVR_IP}/ISAPI/Streaming/channels/${channel}/picture`
        );

        if (!imgResponse.ok) {
            console.warn(`[Channel ${channel}] Snapshot failed: ${imgResponse.status}`);
            return null;
        }

        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        return await sharp(buffer).resize(640, 360).jpeg().toBuffer();
    } catch (err) {
        console.error(`[Channel ${channel}] Error pulling picture:`, err.message);
        return null;
    }
}

async function getChannelRetention(client, channelId) {
    const now = new Date();
    const hundredDaysAgo = new Date();
    hundredDaysAgo.setDate(now.getDate() - 100);

    const startTime = hundredDaysAgo.toISOString().split('.')[0] + 'Z';
    const endTime = now.toISOString().split('.')[0] + 'Z';

    const xmlPayload = 
    `<CMSearchDescription>` +
        `<searchID>C92DC285-8F30-0001-40C6-F0EFA8FB18B5</searchID>` +
        `<trackList><trackID>${channelId}</trackID></trackList>` +
        `<timeSpanList>` +
            `<timeSpan><startTime>${startTime}</startTime><endTime>${endTime}</endTime></timeSpan>` +
        `</timeSpanList>` +
        `<maxResults>10</maxResults>` +
    `</CMSearchDescription>`;

    try {
        const response = await client.fetch(`http://${NVR_IP}/ISAPI/ContentMgmt/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml' },
            body: xmlPayload
        });

        if (!response.ok) return { status: "Error querying recordings" };

        const xmlData = await response.text();
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xmlData);

        const matchResult = result?.CMSearchResult?.matchList?.searchMatchItem;
        if (!matchResult) {
            return { hasRecording: false, retentionDays: 0, message: "No recording found" };
        }

        const items = Array.isArray(matchResult) ? matchResult : [matchResult];
        let oldestDate = new Date();
        let newestDate = new Date(0);

        items.forEach(item => {
            const itemStart = new Date(item.timeSpan?.startTime);
            const itemEnd = new Date(item.timeSpan?.endTime);
            if (itemStart < oldestDate) oldestDate = itemStart;
            if (itemEnd > newestDate) newestDate = itemEnd;
        });

        const diffTime = Math.abs(newestDate - oldestDate);
        return {
            hasRecording: true,
            oldestRecording: oldestDate.toISOString(),
            newestRecording: newestDate.toISOString(),
            retentionDays: Math.ceil(diffTime / (1000 * 60 * 60 * 24))
        };
    } catch (err) {
        return { status: "Failed parsing retention details", error: err.message };
    }
}

// --- MAIN API ROUTE ---

app.get('/api/collage', async (req, res) => {
    try {
        const client = new DigestFetch(USERNAME, PASSWORD);
        const dateStamp = new Date().toISOString().split('T')[0];
        
        const retentionData = {};
        const snapshots = [];

        console.log(`Starting parallel fetch for ${channels.length} channels...`);

        // Execute all requests concurrently for massive speed gains
        const channelPromises = channels.map(async (channel) => {
            const [snapshot, retention] = await Promise.all([
                getChannelSnapshot(client, channel),
                getChannelRetention(client, channel)
            ]);
            
            return { channel, snapshot, retention };
        });

        const results = await Promise.all(channelPromises);

        // Sort results to map them correctly and filter out failed snapshots
        results.forEach(result => {
            retentionData[`channel_${result.channel}`] = result.retention;
            if (result.snapshot) {
                snapshots.push(result.snapshot);
            }
        });

        if (snapshots.length === 0) {
            throw new Error("Could not pull valid image feeds from any configured channel resources.");
        }

        // Dynamic Canvas Math
        const cols = Math.ceil(Math.sqrt(snapshots.length));
        const rows = Math.ceil(snapshots.length / cols);
        const tileWidth = 640;
        const tileHeight = 360;

        const composites = snapshots.map((img, index) => ({
            input: img,
            left: (index % cols) * tileWidth,
            top: Math.floor(index / cols) * tileHeight
        }));

        const collage = await sharp({
            create: {
                width: cols * tileWidth,
                height: rows * tileHeight,
                channels: 3,
                background: { r: 0, g: 0, b: 0 }
            }
        })
        .composite(composites)
        .jpeg({ quality: 85 })
        .toBuffer();

        // File saving
        const imagePath = path.join(uploadsDir, `${dateStamp}-collage.jpg`);
        const jsonPath = path.join(uploadsDir, `${dateStamp}-retention.txt`);

        fs.writeFileSync(imagePath, collage);
        fs.writeFileSync(jsonPath, JSON.stringify(retentionData, null, 4));

        res.json({
            success: true,
            date: dateStamp,
            savedFiles: {
                collage: imagePath,
                retentionText: jsonPath
            },
            retentionPayload: retentionData
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.use('/uploads', express.static(uploadsDir));

app.listen(PORT, () => {
    console.log(`Blazing fast API running on port ${PORT}`);
});