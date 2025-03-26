const express = require('express');
const mysql = require('mysql2');
const WebSocket = require('ws');
const axios = require('axios');
const xml2js = require('xml2js');
const natural = require('natural');

const app = express();
const PORT = 8000;
const wss = new WebSocket.Server({ port: 9090 });

const DB_CONFIG = {
    host: "localhost",
    user: "Gas",
    password: "Gas12!3news",
    database: "rss_feed"
};

const FEEDS = [
    "http://feeds.bbci.co.uk/news/rss.xml",
    "https://ir.thomsonreuters.com/rss/news-releases.xml?items=15",
    "https://ir.thomsonreuters.com/rss/events.xml?items=15",
    "https://www.dailymail.co.uk/articles.rss",
    "https://www.dailymail.co.uk/news/index.rss",
    "https://saharareporters.com/articles/rss-feed",
    "https://www.myjoyonline.com/feed/",
    "https://www.premiumtimesng.com/feed/",
    "https://mg.co.za/feed",
    "https://feeds.capi24.com/v1/Search/articles/news24/TopStories/rss",
    "https://www.herald.co.zw/feed/",
    "https://www.zimlive.com/feed/",
    "https://www.namibian.com.na/feed/",
    "https://www.lusakatimes.com/feed/",
    "https://www.mmegi.bw/rssFeed/1",
    "https://www.moroccoworldnews.com/feed/",
    "https://libyareview.com/feed/",
    "https://sudantribune.com/feed/",
    "https://www.journaldumali.com/feed/",
    'https://businessdayafrica.org/feed/',
    "https://disruptafrica.com/feed/",
    "https://techcabal.com/feed/",
    "https://www.howwemadeitinafrica.com/feed/",
    "https://brittlepaper.com/feed/",
    "https://www.channelstv.com/feed/",
    "https://africacheck.org/feed",
    "https://africanarguments.org/feed/"
];

const db = mysql.createConnection(DB_CONFIG);
db.connect(err => {
    if (err) console.error("Database connection failed:", err);
    else console.log("Connected to MySQL database");
});

const clients = new Set();

// Train Naive Bayes Classifier for Category Prediction
const classifier = new natural.BayesClassifier();
classifier.addDocument("Stock market crashes", "Business");
classifier.addDocument("Economic growth slows", "Business");
classifier.addDocument("Football team wins championship", "Sports");
classifier.addDocument("Basketball player sets record", "Sports");
classifier.addDocument("New AI technology released", "Technology");
classifier.addDocument("Breakthrough in quantum computing", "Technology");
classifier.addDocument("President announces new policy", "Politics");
classifier.addDocument("Government passes new law", "Politics");
classifier.addDocument("Heatlhcare insurance birth", "Health");
classifier.addDocument("Roberry Stolen crime Prison", "Crime");
classifier.train();

async function checkDuplicate(newTitle, newLink) {
    return new Promise((resolve) => {
        db.query("SELECT link, title FROM news_data", (err, results) => {
            if (err) {
                console.error("Database query error:", err);
                resolve(false);
                return;
            }

            const existingLinks = results.map(row => row.link);
            if (existingLinks.includes(newLink)) {
                console.log(`Skipped duplicate link: ${newLink}`);
                resolve(true);
                return;
            }

            resolve(false);
        });
    });
}

// Generate NewsML-G2 format
function generateNewsML(title, link, category, published, added_at) {
    return `<?xml version="1.0"?>
    <newsMessage xmlns="http://iptc.org/std/nar/2006-10-01/">
        <header>
            <sentDate>${new Date().toISOString()}</sentDate>
        </header>
        <newsItem guid="${link}">
            <contentMeta>
                <title>${title}</title>
                <category>${category}</category>
                <pubDate>${published.toISOString()}</pubDate>
                <ingestDate>${added_at.toISOString()}</ingestDate>
            </contentMeta>
            <contentSet>
                <inlineXML>
                    <body>
                        <p>Read more at ${link}</p>
                    </body>
                </inlineXML>
            </contentSet>
        </newsItem>
    </newsMessage>`;
}

// Fetch and store articles
async function fetchAndStore() {
    for (const url of FEEDS) {
        try {
            console.log(`Fetching from: ${url}`);
            const response = await axios.get(url);
            const parsed = await xml2js.parseStringPromise(response.data);

            if (!parsed.rss || !parsed.rss.channel || !parsed.rss.channel[0].item) {
                console.error(`Invalid RSS format from ${url}`);
                continue;
            }

            const items = parsed.rss.channel[0].item;

            for (const item of items) {
                const title = item.title ? item.title[0] : "No title";
                const link = item.link ? item.link[0] : "No link";
                const published = item.pubDate ? new Date(item.pubDate[0]) : new Date();
                const added_at = new Date();

                let category = item.category ? item.category[0] : null;

                // Predict category if missing
                if (!category || category === "Uncategorized") {
                    category = classifier.classify(title);
                    console.log(`Predicted category for "${title}": ${category}`);
                }

                // Check for duplicates before inserting
                const isDuplicate = await checkDuplicate(title, link);
                if (isDuplicate) {
                    console.log(`Skipped duplicate article: "${title}"`);
                    continue;
                }

                const newsML = generateNewsML(title, link, category, published, added_at);

                // Insert into MySQL
                db.query(
                    "INSERT INTO news_data (title, link, category, published, added_at, newsml) VALUES (?, ?, ?, ?, ?, ?)",
                    [title, link, category, published, added_at, newsML],
                    (err) => {
                        if (err) {
                            console.error(`Error inserting article "${title}":`, err);
                        } else {
                            console.log(`Inserted: "${title}"`);
                            notifyClients({ title, link, category, published, added_at, newsML });
                        }
                    }
                );
            }
        } catch (error) {
            console.error(`Error fetching RSS feed from ${url}:`, error.message);
        }
    }
}

// Notify WebSocket clients
function notifyClients(message) {
    const messageJSON = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageJSON);
        }
    });
}

// WebSocket setup
wss.on('connection', ws => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

// Fetch news every 30 seconds
setInterval(fetchAndStore, 30000);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
