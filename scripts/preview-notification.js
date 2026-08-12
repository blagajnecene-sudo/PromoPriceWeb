// Samo za predogled/testiranje. Če je nastavljena okoljska spremenljivka DISCORD_WEBHOOK_URL,
// dejansko poenkrat pošlje testno sporočilo na ta webhook. Sicer samo izpiše JSON payload.

const loc = 'BTC';
const changes = [
    { id: '1234567', title: 'ASUS ROG Strix G16 Gaming Laptop', oldStd: 1499.99, oldPromo: null, newStd: 1499.99, newPromo: 1199.99 },
    { id: '2345678', title: 'Samsung Galaxy S24 128GB Črn', oldStd: 899.00, oldPromo: 799.00, newStd: 899.00, newPromo: 649.00 },
    { id: '3456789', title: 'Sony WH-1000XM5 Slušalke', oldStd: 349.99, oldPromo: 299.99, newStd: 349.99, newPromo: null },
    { id: '4567890', title: 'LG OLED55C4 Televizor', oldStd: 1199.00, oldPromo: null, newStd: 1299.00, newPromo: null },
];

const COLOR_GREEN = 0x2ea043;
const COLOR_RED = 0xda3633;
const MAX_FIELDS_PER_EMBED = 25;

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

function buildEmbeds(title, color, list) {
    const embeds = [];
    for (let i = 0; i < list.length; i += MAX_FIELDS_PER_EMBED) {
        const fields = list.slice(i, i + MAX_FIELDS_PER_EMBED).map(buildChangeField);
        embeds.push({
            title: i === 0 ? title : `${title} (nadaljevanje)`,
            color,
            fields,
            timestamp: new Date().toISOString()
        });
    }
    return embeds;
}

const drops = changes.filter(c => effectivePrice(c.newStd, c.newPromo) < effectivePrice(c.oldStd, c.oldPromo));
const raises = changes.filter(c => effectivePrice(c.newStd, c.newPromo) > effectivePrice(c.oldStd, c.oldPromo));

const embeds = [
    ...buildEmbeds(`📉 Znižanja cen — ${loc}`, COLOR_GREEN, drops),
    ...buildEmbeds(`📈 Zvišanja cen — ${loc}`, COLOR_RED, raises)
];

console.log(JSON.stringify({ embeds }, null, 2));

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (webhookUrl) {
    fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds })
    }).then(r => {
        console.log(r.ok ? 'Poslano na Discord.' : `Discord je vrnil status ${r.status}`);
    }).catch(e => console.error('Napaka pri pošiljanju:', e.message));
} else {
    console.log('\n(DISCORD_WEBHOOK_URL ni nastavljen, sporočilo ni bilo poslano - samo izpis zgoraj.)');
}
