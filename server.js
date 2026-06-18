require('dotenv').config();

const express = require('express');
const sharp = require('sharp');
const DigestFetch = require('digest-fetch');

const app = express();

const PORT = process.env.PORT || 3000;
const NVR_IP = process.env.NVR_IP;
const USERNAME = process.env.NVR_USERNAME;
const PASSWORD = process.env.NVR_PASSWORD;

const channels = process.env.CHANNELS
    .split(',')
    .map(ch => parseInt(ch.trim(), 10));

if (!NVR_IP || !USERNAME || !PASSWORD) {
    console.error('Missing required environment variables.');
    process.exit(1);
}

app.get('/collage', async (req, res) => {
    try {
        const client = new DigestFetch(USERNAME, PASSWORD);

        const snapshots = [];

        for (const channel of channels) {
            console.log(`Fetching channel ${channel}`);

            const response = await client.fetch(
                `http://${NVR_IP}/ISAPI/Streaming/channels/${channel}/picture`
            );

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch channel ${channel}: ${response.status}`
                );
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            const resized = await sharp(buffer)
                .resize(640, 360)
                .jpeg()
                .toBuffer();

            snapshots.push(resized);
        }

        const cols = 2;
        const rows = Math.ceil(snapshots.length / cols);

        const tileWidth = 640;
        const tileHeight = 360;

        const canvasWidth = cols * tileWidth;
        const canvasHeight = rows * tileHeight;

        const composites = snapshots.map((img, index) => ({
            input: img,
            left: (index % cols) * tileWidth,
            top: Math.floor(index / cols) * tileHeight
        }));

        const collage = await sharp({
            create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 3,
                background: {
                    r: 255,
                    g: 255,
                    b: 255
                }
            }
        })
        .composite(composites)
        .jpeg({
            quality: 90
        })
        .toBuffer();

        res.set('Content-Type', 'image/jpeg');
        res.send(collage);

    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.get('/', (req, res) => {
    res.json({
        success: true,
        endpoint: '/collage'
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});