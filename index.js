const TradingView = require('@mathieuc/tradingview');
const { EMA } = require('technicalindicators');
const fs = require('fs');

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

const tgModule = require('node-telegram-bot-api');
const TelegramBot = tgModule.default || tgModule;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
    console.error("❌ ขาด TELEGRAM_TOKEN หรือ CHAT_ID กรุณาตั้งค่าใน GitHub Secrets");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getUSSymbols() {
    const fallbackFile = 'us_symbols_fallback.json'; 
    try {
        console.log('🔄 กำลังเชื่อมต่อ TradingView เพื่อดึงรายชื่อหุ้น US (กรอง EMA Cross และ OTC)...');
        
        const response = await fetch('https://scanner.tradingview.com/america/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({
                filter: [
                    { left: "type", operation: "equal", right: "stock" },
                    { left: "MACD.macd", operation: "crosses_above", right: 0 }
                ],
                options: { lang: "en" },
                markets: ["america"],
                symbols: { query: { types: [] }, tickers: [] },
                columns: ["name", "close", "MACD.macd"],
                sort: { sortBy: "name", sortOrder: "asc" },
                range: [0, 5000] 
            })
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const json = await response.json();
        
        const symbols = json.data
            .map(item => item.s)
            .filter(symbol => {
                return !symbol.startsWith('OTC:') && !symbol.endsWith('.R') && !symbol.endsWith('.F');
            });

        console.log(`✅ พบหุ้น US ที่เกิด EMA Cross (ไม่รวม OTC) จำนวน ${symbols.length} ตัว`);
        fs.writeFileSync(fallbackFile, JSON.stringify(symbols, null, 2));
        return symbols;

    } catch (error) {
        console.error('❌ ดึงรายชื่อหุ้นจาก API ล้มเหลว:', error.message);
        if (fs.existsSync(fallbackFile)) {
            const fileData = fs.readFileSync(fallbackFile, 'utf8');
            return JSON.parse(fileData);
        } else {
            return [];
        }
    }
}

async function fetchFromYahooFinance(tvSymbol) {
    try {
        const ticker = tvSymbol.split(':')[1];
        const yfSymbol = ticker; 

        const period2 = new Date();
        const period1 = new Date();
        period1.setDate(period2.getDate() - 600);

        const result = await yahooFinance.chart(yfSymbol, {
            period1: period1, period2: period2, interval: '1d'
        });

        if (!result || !result.quotes || result.quotes.length === 0) return [];
        const validQuotes = result.quotes.filter(c => c.close !== null && c.high !== null && c.low !== null);

        return validQuotes.map(c => ({
            time: Math.floor(c.date.getTime() / 1000),
            open: c.open, max: c.high, min: c.low, close: c.close, volume: c.volume
        }));
    } catch (error) {
        console.error(`      ❌ Yahoo Finance ก็ล้มเหลว: ${error.message}`);
        return [];
    }
}

async function fetchCandlesWithFallback(symbol) {
    return new Promise(async (resolve) => {
        let isResolved = false;
        const client = new TradingView.Client();
        const chart = new client.Session.Chart();
        let debounceTimer;

        chart.setMarket(symbol, { timeframe: '1D', range: 400 });

        const tvTimeout = setTimeout(async () => {
            if (isResolved) return;
            isResolved = true;
            client.end();
            resolve(await fetchFromYahooFinance(symbol));
        }, 8000);

        chart.onUpdate(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (isResolved) return;
                isResolved = true;
                clearTimeout(tvTimeout);
                const rawCandles = chart.periods;
                const candles = [...rawCandles].reverse();
                client.end();
                resolve(candles);
            }, 500);
        });

        chart.onError(async (err) => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(tvTimeout);
            client.end();
            resolve(await fetchFromYahooFinance(symbol));
        });
    });
}

function checkWave2Status(candles, pivotLength, fibLevel = 0.786) {
    if (candles.length < pivotLength * 2) return { isValid: false, reason: "ข้อมูลแท่งเทียนไม่พอคำนวณ" };

    let peakIndex = -1, peakPrice = -Infinity;
    let baseIndex = -1, basePrice = Infinity;

    for (let i = candles.length - 1 - pivotLength; i >= pivotLength; i--) {
        let isHigh = true;
        const currentHigh = Number(candles[i].max);
        for (let j = 1; j <= pivotLength; j++) {
            const pastHigh = Number(candles[i - j].max);
            const futureHigh = Number(candles[i + j].max);
            if (currentHigh < pastHigh || currentHigh <= futureHigh) {
                isHigh = false; break;
            }
        }
        if (isHigh) { peakIndex = i; peakPrice = currentHigh; break; }
    }

    if (peakIndex === -1) return { isValid: false, reason: `หา Peak ล่าสุดย้อนหลัง ${pivotLength} แท่งไม่เจอ` };

    const searchLimit = Math.max(0, peakIndex - (pivotLength * 5));
    for (let i = peakIndex - 1; i >= searchLimit; i--) {
        const currentLow = Number(candles[i].min);
        if (currentLow < basePrice) { basePrice = currentLow; baseIndex = i; }
    }

    if (baseIndex === -1 || peakPrice <= basePrice) {
        return { isValid: false, reason: `หา Base ไม่เจอ` };
    }

    const fibPrice = peakPrice - ((peakPrice - basePrice) * fibLevel);
    let hasTouchedFib = false, hasBrokenLow = false;

    for (let i = peakIndex + 1; i < candles.length; i++) {
        const currentLow = Number(candles[i].min);
        if (currentLow <= fibPrice) hasTouchedFib = true;
        if (currentLow < basePrice) hasBrokenLow = true;
    }

    let waveStatusReason = "✅ ลงมาเทส Fibo และไม่หลุด Low";
    if (hasBrokenLow) waveStatusReason = "❌ ราคาเทสลึกจนหลุด Swing Low เดิมไปแล้ว";
    else if (!hasTouchedFib) waveStatusReason = "❌ ราคายังย่อตัวลงมาไม่ถึงระดับ Fibo 78.6%";

    return {
        isValid: hasTouchedFib && !hasBrokenLow,
        base: basePrice.toFixed(2), peak: peakPrice.toFixed(2), fib: fibPrice.toFixed(2), reason: waveStatusReason
    };
}

async function analyzeStock(symbol) {
    try {
        const candles = await fetchCandlesWithFallback(symbol);
        if (!candles || candles.length < 200) {
            return { success: false, reason: 'ข้อมูลแท่งเทียนไม่เพียงพอ' };
        }

        const currentPrice = Number(candles[candles.length - 1].close).toFixed(2);
        const closePrices = candles.map(c => Number(c.close));
        const ema12 = EMA.calculate({ period: 12, values: closePrices });
        const ema26 = EMA.calculate({ period: 26, values: closePrices });

        if (ema12.length < 3 || ema26.length < 3) return { success: false, reason: 'ข้อมูล EMA ไม่เพียงพอ' };

        const confirmedEma12 = ema12[ema12.length - 2];
        const pastEma12 = ema12[ema12.length - 3];
        const confirmedEma26 = ema26[ema26.length - 2];
        const pastEma26 = ema26[ema26.length - 3];

        const emaCrossUp = pastEma12 <= pastEma26 && confirmedEma12 > confirmedEma26;

        const w2_Day = checkWave2Status(candles, 21);
        const w2_Week = checkWave2Status(candles, 65);
        const w2_Month = checkWave2Status(candles, 160);

        const validWave2 = w2_Day.isValid || w2_Week.isValid || w2_Month.isValid;
        let matchedTF = null, details = null;

        if (validWave2) {
            details = w2_Day.isValid ? w2_Day : (w2_Week.isValid ? w2_Week : w2_Month);
            matchedTF = w2_Day.isValid ? "Day (21)" : (w2_Week.isValid ? "Week (13)" : "Month (8)");
        }

        return {
            success: true, isMatch: emaCrossUp && validWave2, tfMatch: matchedTF,
            details: details, currentPrice: currentPrice, emaStatus: emaCrossUp, w2_Day: w2_Day
        };

    } catch (err) {
        return { success: false, reason: err.message };
    }
}

async function sendTelegramMessage(text) {
    try {
        await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (error) {
        console.error('ส่งข้อความ Telegram ล้มเหลว:', error.message);
    }
}

async function startAutomatedScan() {
    const symbols = await getUSSymbols(); 
    if (symbols.length === 0) return; 

    console.log(`\n[${new Date().toLocaleString()}] 🚀 เริ่มต้นสแกนหุ้นทั้งหมด ${symbols.length} ตัว\n` + '-'.repeat(60));
    await sendTelegramMessage(`🎬 *ระบบเริ่มทำการสแกนหุ้น US ประจำวัน*\nจำนวนหุ้นในคิว: ${symbols.length} ตัว`); 

    let matchCount = 0;

    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        console.log(`[${i + 1}/${symbols.length}] 🔍 กำลังตรวจสอบ: ${symbol}`);
        const result = await analyzeStock(symbol);

        if (result.success) {
            if (result.isMatch) {
                matchCount++;
                const tvLink = `https://www.tradingview.com/chart/JapEZ3ir/?symbol=${symbol}`;
                const googleLink = `https://www.google.com/search?q=stock+${symbol}&udm=50`;
                                
                const msg = `🚨 *CDC Wave 2 Signal (US Market)* 🚨\n\n` +
                            `📈 หุ้น: \`${symbol}\` ➡️ [🔍 ค้นหา Google](${googleLink})\n` +
                            `⏱ Timeframe อ้างอิง: *${result.tfMatch}*\n` +
                            `- Swing High: ${result.details.peak}\n` +
                            `- Swing Low (Base): ${result.details.base}\n` +
                            `- Fib 78.6%: ${result.details.fib}\n` +
                            `- ราคาปัจจุบัน: ${result.currentPrice}\n\n` +
                            `🔗 [เปิดกราฟบน TradingView](${tvLink})`;
                
                await sendTelegramMessage(msg);
                console.log(`🎉 [MATCH!] ส่งสัญญาณ ${symbol} เข้า Telegram เรียบร้อยแล้ว!`);
            }
        }
        await delay(1000);
    }
    await sendTelegramMessage(`🏁 *การสแกนสิ้นสุด*\nพบหุ้นเข้าเงื่อนไขวันนี้: *${matchCount}* ตัว`);
}

startAutomatedScan();