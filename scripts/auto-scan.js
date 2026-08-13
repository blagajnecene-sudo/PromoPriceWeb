// Urni server-side scan cen za vse poslovalnice + Discord obvestila o spremembah.
// Teče preko GitHub Actions cron (.github/workflows/auto-scan.yml), ne rabi odprtega brskalnika.

const admin = require('firebase-admin');
const cheerio = require('cheerio');

const SCAN_API = 'https://promoprice.onrender.com/api/scan';
const BATCH_SIZE = 5;
const DELAY_MS = 1000;
const MAX_HISTORY = 10; // Firestore ima limit 1 MiB/dokument - zgodovina se ne sme kopičiti brez meje
const TIMEZONE = 'Europe/Ljubljana';
const QUIET_HOUR_START = 21; // 21:00 - obvestila utihnejo
const QUIET_HOUR_END = 7;    // 07:00 - obvestila se spet vklopijo

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error('Manjka FIREBASE_SERVICE_ACCOUNT_JSON okoljska spremenljivka.');
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function parsePrice(str) {
    return parseFloat(str.replace(/\./g, '').replace(/,/g, '.').replace(/[^\d.]/g, ''));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getLocalHourAndWeekday(timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour: 'numeric', hour12: false, weekday: 'short'
    }).formatToParts(new Date());
    let hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    if (hour === 24) hour = 0;
    const weekday = parts.find(p => p.type === 'weekday').value; // 'Sun', 'Mon', ...
    return { hour, weekday };
}

function isQuietTime() {
    const { hour, weekday } = getLocalHourAndWeekday(TIMEZONE);
    if (weekday === 'Sun') return true; // cela nedelja brez obvestil
    if (hour >= QUIET_HOUR_START || hour < QUIET_HOUR_END) return true; // vsak dan 21:00-07:00
    return false;
}

const FETCH_TIMEOUT_MS = 20000;

async function scanItem(id) {
    try {
        const r = await fetch(`${SCAN_API}?id=${id}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) return null;

        const data = await r.json();
        if (data.error) return null;

        const $ = cheerio.load(data.html);
        const priceEl = $('.price-section-redesign__price, .price-box__price').first();
        if (!priceEl.length) return null;

        let promo = null;
        $('.better-price').each((_, el) => {
            if (promo !== null) return;
            const $el = $(el);
            if ($el.html().toUpperCase().includes('SMART')) return;
            const amountEl = $el.find('.better-price__amount');
            if (amountEl.length) promo = parsePrice(amountEl.text());
        });

        const std = parsePrice(priceEl.text());
        const title = $('h1.detail__title').first().text().trim() || 'Neznano';
        const now = new Date();

        return {
            id,
            date: now.toLocaleDateString('sl-SI'),
            time: now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0'),
            std, promo, title
        };
    } catch (e) {
        console.error(`Napaka pri skeniranju ${id}:`, e.message);
        return null;
    }
}

const COLOR_GREEN = 0x2ea043;
const COLOR_RED = 0xda3633;
const MAX_FIELDS_PER_EMBED = 25;
const MAX_EMBEDS_PER_MESSAGE = 10;

function effectivePrice(std, promo) {
    return (promo && promo < std) ? promo : std;
}

function buildChangeField(c) {
    const oldPrice = effectivePrice(c.oldStd, c.oldPromo);
    const newPrice = effectivePrice(c.newStd, c.newPromo);
    const isPromo = c.newPromo && c.newPromo < c.newStd;
    const promoTag = isPromo ? ' 🏷️ PROMO' : '';
    return {
        name: c.title,
        value: `\`${c.id}\` | ${oldPrice.toFixed(2)} € → ${newPrice.toFixed(2)} €${promoTag}`
    };
}

function buildEmbeds(title, color, changes) {
    const embeds = [];
    for (let i = 0; i < changes.length; i += MAX_FIELDS_PER_EMBED) {
        const fields = changes.slice(i, i + MAX_FIELDS_PER_EMBED).map(buildChangeField);
        embeds.push({
            title: i === 0 ? title : `${title} (nadaljevanje)`,
            color,
            fields,
            timestamp: new Date().toISOString()
        });
    }
    return embeds;
}

async function sendDiscordNotification(webhookUrl, loc, changes) {
    if (!webhookUrl || !changes.length) return;

    const drops = changes.filter(c => effectivePrice(c.newStd, c.newPromo) < effectivePrice(c.oldStd, c.oldPromo));
    const raises = changes.filter(c => effectivePrice(c.newStd, c.newPromo) > effectivePrice(c.oldStd, c.oldPromo));

    let embeds = [
        ...buildEmbeds(`📉 Znižanja cen — ${loc}`, COLOR_GREEN, drops),
        ...buildEmbeds(`📈 Zvišanja cen — ${loc}`, COLOR_RED, raises)
    ];

    if (embeds.length > MAX_EMBEDS_PER_MESSAGE) {
        console.log(`[${loc}] Preveč sprememb za en Discord embed nabor (${embeds.length}), prikazanih bo le prvih ${MAX_EMBEDS_PER_MESSAGE}.`);
        embeds = embeds.slice(0, MAX_EMBEDS_PER_MESSAGE);
    }

    try {
        const r = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds })
        });
        if (!r.ok) console.error(`Discord webhook vrnil status ${r.status} za ${loc}`);
    } catch (e) {
        console.error('Napaka pri pošiljanju Discord obvestila:', e.message);
    }
}

async function sendHeartbeat(webhookUrl, loc, itemCount) {
    if (!webhookUrl) return;

    try {
        const r = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `✅ Preverjeno — ${loc}`,
                    description: `Brez sprememb cen. Preverjenih ${itemCount} artiklov.`,
                    color: 0x8b949e,
                    timestamp: new Date().toISOString()
                }]
            })
        });
        if (!r.ok) console.error(`Discord webhook (heartbeat) vrnil status ${r.status} za ${loc}`);
    } catch (e) {
        console.error('Napaka pri pošiljanju heartbeat obvestila:', e.message);
    }
}

async function processLocation(loc) {
    const docRef = db.collection('baza_poslovalnic').doc(loc);
    const snap = await docRef.get();
    if (!snap.exists) return;

    const dbData = snap.data();
    const ids = Object.keys(dbData);
    if (!ids.length) {
        console.log(`[${loc}] Baza je prazna, preskočeno.`);
        return;
    }

    // Firestore dovoljuje največ 1 MiB na dokument - normaliziraj obliko in
    // vsili omejitev zgodovine takoj ob branju, ne šele ob morebitnem novem zapisu.
    for (const id of ids) {
        const entry = dbData[id];
        let hist = Array.isArray(entry) ? entry : (entry && entry.history) || [];
        if (hist.length > MAX_HISTORY) hist = hist.slice(-MAX_HISTORY);
        dbData[id] = { history: hist };
    }

    const settingsSnap = await db.collection('nastavitve_poslovalnic').doc(loc).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const autoScanEnabled = settings.autoScanEnabled !== false;
    if (!autoScanEnabled) {
        console.log(`[${loc}] Samodejno osveževanje je izklopljeno, preskočeno.`);
        return;
    }

    const webhookUrl = settings.webhookUrl || null;
    const intervalHours = settings.intervalHours || 1;
    const notifyEnabled = settings.notifyEnabled !== false;
    const heartbeatEnabled = settings.heartbeatEnabled === true;

    const currentHour = new Date().getUTCHours();
    if (currentHour % intervalHours !== 0) {
        console.log(`[${loc}] Preskočeno (interval ${intervalHours}h, trenutna ura UTC ${currentHour}).`);
        return;
    }

    const changes = [];
    console.log(`[${loc}] Začenjam skeniranje ${ids.length} artiklov...`);

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batchIds = ids.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batchIds.map(scanItem));
        console.log(`[${loc}] ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length} preverjenih...`);

        results.forEach((res, idx) => {
            if (!res) return;
            const id = batchIds[idx];

            let entry = dbData[id];
            let hist = Array.isArray(entry) ? entry : entry.history;
            const prev = (hist && hist.length > 0) ? hist[hist.length - 1] : null;

            let newTag = (res.promo && res.promo < res.std) ? 'yellow' : null;
            if (prev) {
                const prevStatus = prev.tagStatus || (prev.promo && prev.promo < prev.std ? 'yellow' : null);
                if (prevStatus === 'purple' || prevStatus === 'red') {
                    const oldPrice = prev.promo || prev.std;
                    const newPrice = res.promo || res.std;
                    newTag = (oldPrice !== newPrice) ? 'red' : prevStatus;
                }
            }
            res.tagStatus = newTag;

            if (prev && (prev.std !== res.std || prev.promo !== res.promo)) {
                changes.push({
                    id, title: res.title,
                    oldStd: prev.std, oldPromo: prev.promo,
                    newStd: res.std, newPromo: res.promo
                });
            }

            dbData[id].history.push(res);
            while (dbData[id].history.length > MAX_HISTORY) dbData[id].history.shift();
        });

        if (i + BATCH_SIZE < ids.length) await sleep(DELAY_MS);
    }

    await docRef.set(dbData);
    await db.collection('nastavitve_poslovalnic').doc(loc).set({
        lastUpdated: new Date().toISOString(),
        lastUpdateSource: 'auto'
    }, { merge: true });
    console.log(`[${loc}] Skeniranih ${ids.length} artiklov, ${changes.length} sprememb.`);

    const quiet = isQuietTime();
    if (changes.length) {
        if (notifyEnabled) {
            if (quiet) console.log(`[${loc}] Tiho obdobje (ned. ali 21:00-07:00) - Discord obvestilo o spremembah preskočeno.`);
            else await sendDiscordNotification(webhookUrl, loc, changes);
        }
    } else if (heartbeatEnabled) {
        if (quiet) console.log(`[${loc}] Tiho obdobje (ned. ali 21:00-07:00) - heartbeat preskočen.`);
        else await sendHeartbeat(webhookUrl, loc, ids.length);
    }
}

async function main() {
    const locationDocs = await db.collection('baza_poslovalnic').listDocuments();
    for (const docRef of locationDocs) {
        try {
            await processLocation(docRef.id);
        } catch (e) {
            console.error(`[${docRef.id}] Napaka pri obdelavi lokacije, nadaljujem z ostalimi:`, e.message);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch(e => { console.error('Napaka v auto-scan skriptu:', e); process.exit(1); });
