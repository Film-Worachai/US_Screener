const TradingView = require('@mathieuc/tradingview'); //[cite: 1]
const { EMA } = require('technicalindicators'); //[cite: 1]
const fs = require('fs'); //[cite: 1]

const YahooFinance = require('yahoo-finance2').default; //[cite: 1]
const yahooFinance = new YahooFinance(); //[cite: 1]

const tgModule = require('node-telegram-bot-api'); //[cite: 1]
const TelegramBot = tgModule.default || tgModule; //[cite: 1]

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; //[cite: 1]
const CHAT_ID = process.env.CHAT_ID; //[cite: 1]

if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("❌ ขาด TELEGRAM_TOKEN หรือ CHAT_ID กรุณาตั้งค่าใน GitHub Secrets"); //[cite: 1]
    process.exit(1); //[cite: 1]
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false }); //[cite: 1]
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); //[cite: 1]

async function getUSSymbols() {
    const fallbackFile = 'us_symbols_fallback.json'; 
    try {
        console.log('🔄 กำลังเชื่อมต่อ TradingView เพื่อดึงรายชื่อหุ้น US (กรอง EMA Cross)...');
        
        const response = await fetch('https://scanner.tradingview.com/america/scan', { //[cite: 2]
            method: 'POST', //[cite: 2]
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, //[cite: 1]
            body: JSON.stringify({
                filter: [
                    { left: "type", operation: "equal", right: "stock" }, //[cite: 1]
                    { left: "MACD.macd", operation: "crosses_above", right: 0 } //[cite: 2]
                ],
                options: { lang: "en" }, //[cite: 2]
                markets: ["america"], //[cite: 2]
                symbols: { query: { types: [] }, tickers: [] }, //[cite: 1]
                columns: ["name", "close", "MACD.macd"], //[cite: 2]
                sort: { sortBy: "name", sortOrder: "asc" }, //[cite: 1]
                range: [0, 5000] 
            })
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`); //[cite: 1]

        const json = await response.json(); //[cite: 1]
        
        const symbols = json.data
            .map(item => item.s) //[cite: 1]
            .filter(symbol => {
                return !symbol.endsWith('.R') && !symbol.endsWith('.F'); //[cite: 2]
            });

        console.log(`✅ พบหุ้น US ที่เกิด EMA Cross จำนวน ${symbols.length} ตัว (ดึงจาก API ล่าสุด)`);
        fs.writeFileSync(fallbackFile, JSON.stringify(symbols, null, 2)); //[cite: 1]
        return symbols;

    } catch (error) {
        console.error('❌ ดึงรายชื่อหุ้นจาก API ล้มเหลว:', error.message); //[cite: 1]
        if (fs.existsSync(fallbackFile)) { //[cite: 1]
            const fileData = fs.readFileSync(fallbackFile, 'utf8'); //[cite: 1]
            return JSON.parse(fileData); //[cite: 1]
        } else {
            return []; //[cite: 1]
        }
    }
}

async function fetchFromYahooFinance(tvSymbol) {
    try {
        const ticker = tvSymbol.split(':')[1]; //[cite: 1]
        const yfSymbol = ticker; 

        const period2 = new Date(); //[cite: 1]
        const period1 = new Date(); //[cite: 1]
        period1.setDate(period2.getDate() - 600); //[cite: 1]

        const result = await yahooFinance.chart(yfSymbol, { //[cite: 1]
            period1: period1, period2: period2, interval: '1d' //[cite: 1]
        });

        if (!result || !result.quotes || result.quotes.length === 0) return []; //[cite: 1]
        const validQuotes = result.quotes.filter(c => c.close !== null && c.high !== null && c.low !== null); //[cite: 1]

        return validQuotes.map(c => ({
            time: Math.floor(c.date.getTime() / 1000), //[cite: 1]
            open: c.open, max: c.high, min: c.low, close: c.close, volume: c.volume //[cite: 1]
        }));
    } catch (error) {
        console.error(`      ❌ Yahoo Finance ก็ล้มเหลว: ${error.message}`); //[cite: 1]
        return []; //[cite: 1]
    }
}

async function fetchCandlesWithFallback(symbol) {
    return new Promise(async (resolve) => {
        let isResolved = false; //[cite: 1]
        const client = new TradingView.Client(); //[cite: 1]
        const chart = new client.Session.Chart(); //[cite: 1]
        let debounceTimer; //[cite: 1]

        chart.setMarket(symbol, { timeframe: '1D', range: 400 }); //[cite: 1]

        const tvTimeout = setTimeout(async () => {
            if (isResolved) return; //[cite: 1]
            isResolved = true; //[cite: 1]
            client.end(); //[cite: 1]
            resolve(await fetchFromYahooFinance(symbol)); //[cite: 1]
        }, 8000); //[cite: 1]

        chart.onUpdate(() => {
            clearTimeout(debounceTimer); //[cite: 1]
            debounceTimer = setTimeout(() => {
                if (isResolved) return; //[cite: 1]
                isResolved = true; //[cite: 1]
                clearTimeout(tvTimeout); //[cite: 1]
                const rawCandles = chart.periods; //[cite: 1]
                const candles = [...rawCandles].reverse(); //[cite: 1]
                client.end(); //[cite: 1]
                resolve(candles); //[cite: 1]
            }, 500); //[cite: 1]
        });

        chart.onError(async (err) => {
            if (isResolved) return; //[cite: 1]
            isResolved = true; //[cite: 1]
            clearTimeout(tvTimeout); //[cite: 1]
            client.end(); //[cite: 1]
            resolve(await fetchFromYahooFinance(symbol)); //[cite: 1]
        });
    });
}

function checkWave2Status(candles, pivotLength, fibLevel = 0.786) { //[cite: 1]
    if (candles.length < pivotLength * 2) return { isValid: false, reason: "ข้อมูลแท่งเทียนไม่พอคำนวณ" }; //[cite: 1]

    let peakIndex = -1, peakPrice = -Infinity; //[cite: 1]
    let baseIndex = -1, basePrice = Infinity; //[cite: 1]

    for (let i = candles.length - 1 - pivotLength; i >= pivotLength; i--) { //[cite: 1]
        let isHigh = true; //[cite: 1]
        const currentHigh = Number(candles[i].max); //[cite: 1]
        for (let j = 1; j <= pivotLength; j++) { //[cite: 1]
            const pastHigh = Number(candles[i - j].max); //[cite: 1]
            const futureHigh = Number(candles[i + j].max); //[cite: 1]
            if (currentHigh < pastHigh || currentHigh <= futureHigh) { //[cite: 1]
                isHigh = false; break; //[cite: 1]
            }
        }
        if (isHigh) { peakIndex = i; peakPrice = currentHigh; break; } //[cite: 1]
    }

    if (peakIndex === -1) return { isValid: false, reason: `หา Peak ล่าสุดย้อนหลัง ${pivotLength} แท่งไม่เจอ` }; //[cite: 1]

    const searchLimit = Math.max(0, peakIndex - (pivotLength * 5)); //[cite: 1]
    for (let i = peakIndex - 1; i >= searchLimit; i--) { //[cite: 1]
        const currentLow = Number(candles[i].min); //[cite: 1]
        if (currentLow < basePrice) { basePrice = currentLow; baseIndex = i; } //[cite: 1]
    }

    if (baseIndex === -1 || peakPrice <= basePrice) { //[cite: 1]
        return { isValid: false, reason: `หา Base ไม่เจอ` }; //[cite: 1]
    }

    const fibPrice = peakPrice - ((peakPrice - basePrice) * fibLevel); //[cite: 1]
    let hasTouchedFib = false, hasBrokenLow = false; //[cite: 1]

    for (let i = peakIndex + 1; i < candles.length; i++) { //[cite: 1]
        const currentLow = Number(candles[i].min); //[cite: 1]
        if (currentLow <= fibPrice) hasTouchedFib = true; //[cite: 1]
        if (currentLow < basePrice) hasBrokenLow = true; //[cite: 1]
    }

    let waveStatusReason = "✅ ลงมาเทส Fibo และไม่หลุด Low"; //[cite: 1]
    if (hasBrokenLow) waveStatusReason = "❌ ราคาเทสลึกจนหลุด Swing Low เดิมไปแล้ว"; //[cite: 1]
    else if (!hasTouchedFib) waveStatusReason = "❌ ราคายังย่อตัวลงมาไม่ถึงระดับ Fibo 78.6%"; //[cite: 1]

    return {
        isValid: hasTouchedFib && !hasBrokenLow, //[cite: 1]
        base: basePrice.toFixed(2), peak: peakPrice.toFixed(2), fib: fibPrice.toFixed(2), reason: waveStatusReason //[cite: 1]
    };
}

async function analyzeStock(symbol) {
    try {
        const candles = await fetchCandlesWithFallback(symbol); //[cite: 1]
        if (!candles || candles.length < 200) { //[cite: 1]
            return { success: false, reason: 'ข้อมูลแท่งเทียนไม่เพียงพอ' }; //[cite: 1]
        }

        const currentPrice = Number(candles[candles.length - 1].close).toFixed(2); //[cite: 1]
        const closePrices = candles.map(c => Number(c.close)); //[cite: 1]
        const ema12 = EMA.calculate({ period: 12, values: closePrices }); //[cite: 1]
        const ema26 = EMA.calculate({ period: 26, values: closePrices }); //[cite: 1]

        if (ema12.length < 3 || ema26.length < 3) return { success: false, reason: 'ข้อมูล EMA ไม่เพียงพอ' }; //[cite: 1]

        const confirmedEma12 = ema12[ema12.length - 2]; //[cite: 1]
        const pastEma12 = ema12[ema12.length - 3]; //[cite: 1]
        const confirmedEma26 = ema26[ema26.length - 2]; //[cite: 1]
        const pastEma26 = ema26[ema26.length - 3]; //[cite: 1]

        const emaCrossUp = pastEma12 <= pastEma26 && confirmedEma12 > confirmedEma26; //[cite: 1]

        const w2_Day = checkWave2Status(candles, 21); //[cite: 1]
        const w2_Week = checkWave2Status(candles, 65); //[cite: 1]
        const w2_Month = checkWave2Status(candles, 160); //[cite: 1]

        const validWave2 = w2_Day.isValid || w2_Week.isValid || w2_Month.isValid; //[cite: 1]
        let matchedTF = null, details = null; //[cite: 1]

        if (validWave2) {
            details = w2_Day.isValid ? w2_Day : (w2_Week.isValid ? w2_Week : w2_Month); //[cite: 1]
            matchedTF = w2_Day.isValid ? "Day (21)" : (w2_Week.isValid ? "Week (13)" : "Month (8)"); //[cite: 1]
        }

        return {
            success: true, isMatch: emaCrossUp && validWave2, tfMatch: matchedTF, //[cite: 1]
            details: details, currentPrice: currentPrice, emaStatus: emaCrossUp, w2_Day: w2_Day //[cite: 1]
        };

    } catch (err) {
        return { success: false, reason: err.message }; //[cite: 1]
    }
}

async function sendTelegramMessage(text) {
    try {
        await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown', disable_web_page_preview: true }); //[cite: 1]
    } catch (error) {
        console.error('ส่งข้อความ Telegram ล้มเหลว:', error.message); //[cite: 1]
    }
}

async function startAutomatedScan() {
    const symbols = await getUSSymbols(); 
    if (symbols.length === 0) return; 

    console.log(`\n[${new Date().toLocaleString()}] 🚀 เริ่มต้นสแกนหุ้นทั้งหมด ${symbols.length} ตัว\n` + '-'.repeat(60)); //[cite: 1]
    await sendTelegramMessage(`🎬 *ระบบเริ่มทำการสแกนหุ้น US ประจำวัน*\nจำนวนหุ้นในคิว: ${symbols.length} ตัว`); 

    let matchCount = 0; //[cite: 1]

    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i]; //[cite: 1]
        console.log(`[${i + 1}/${symbols.length}] 🔍 กำลังตรวจสอบ: ${symbol}`); //[cite: 1]
        const result = await analyzeStock(symbol); //[cite: 1]

        if (result.success) {
            if (result.isMatch) {
                matchCount++; //[cite: 1]
                const tvLink = `https://www.tradingview.com/chart/JapEZ3ir/?symbol=${symbol}`; //[cite: 1]
                const googleLink = `https://www.google.com/search?q=stock+${symbol}&udm=50`;
                                
                const msg = `🚨 *CDC Wave 2 Signal (US Market)* 🚨\n\n` +
                            `📈 หุ้น: \`${symbol}\` ➡️ [🔍 ค้นหา Google](${googleLink})\n` +
                            `⏱ Timeframe อ้างอิง: *${result.tfMatch}*\n` + //[cite: 1]
                            `- Swing High: ${result.details.peak}\n` + //[cite: 1]
                            `- Swing Low (Base): ${result.details.base}\n` + //[cite: 1]
                            `- Fib 78.6%: ${result.details.fib}\n` + //[cite: 1]
                            `- ราคาปัจจุบัน: ${result.currentPrice}\n\n` + //[cite: 1]
                            `🔗 [เปิดกราฟบน TradingView](${tvLink})`; //[cite: 1]
                
                await sendTelegramMessage(msg); //[cite: 1]
                console.log(`🎉 [MATCH!] ส่งสัญญาณ ${symbol} เข้า Telegram เรียบร้อยแล้ว!`); //[cite: 1]
            }
        }
        await delay(1000); //[cite: 1]
    }
    await sendTelegramMessage(`🏁 *การสแกนสิ้นสุด*\nพบหุ้นเข้าเงื่อนไขวันนี้: *${matchCount}* ตัว`); //[cite: 1]
}

startAutomatedScan(); //[cite: 1]