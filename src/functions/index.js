const axios = require("axios")
const TelegramBot = require("node-telegram-bot-api")
const { app } = require('@azure/functions');
require("dotenv").config()

const greenCheck = '\u2705'; // ✅
const redCross = '\u274C';  // ❌
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

const serverUrl = process.env.SHLINK_URL
const redirectTable = JSON.parse(process.env.SHLINK_REDIRECT_TABLE)

var lastCodeGreen = 0;

async function telegramMessage(msg) {
    await bot.sendMessage(process.env.TELEGRAM_GROUP_ID, msg, { disable_web_page_preview: true })
}

async function errorLog(ctx, msg, error = null) {
    ctx.log(msg)
    if (error)
        ctx.log(error)
    await telegramMessage(`${redCross} ${msg}`)
}

async function msgLog(ctx, msg, telegram = false) {
    ctx.log(msg)
    if (telegram) {
        await telegramMessage(`${greenCheck} ${msg}`)
    }

}

function updateLastCodeGreen(ctx) {
    if (lastCodeGreen + process.env.TELEGRAM_CODE_GREEN_CYCLE < Date.now()) {
        lastCodeGreen = Date.now()
        ctx.log("send code green")
        return true
    } else {
        ctx.log("skip sending code green")
        return false
    }
}

async function axiosGet(requestUrl) {
    return await axios({
        url: requestUrl,
        method: `get`,
        timeout: 20000,
        maxRedirects: 0,
        validateStatus: (status) =>
            status >= 200 && status < 400,
    })
}

async function checkRedirectTable(ctx, telegram = false) {
    for (const entry of redirectTable) {
        const url = serverUrl + "/" + entry.suffix
        try {
            const response = await axiosGet(serverUrl + "/" + entry.suffix)

            if (response.status == 302 && response.headers.location == entry.redirect) {
                await msgLog(ctx, `successful checked url ${url} -> ${entry.redirect}`, telegram)
            } else {
                await errorLog(ctx, `error checking url ${url}`)
                await errorLog(ctx, `response status = ${response.status}`)
                await errorLog(ctx, `${response.headers.location} ?= ${entry.redirect}`)
            }
        } catch (error) {
            await errorLog(ctx, `error fetch url ${url}`, error)
        }
    }
}

async function checkShlinkStatus(ctx, telegram = false) {
    const url = serverUrl + "/rest/health"
    try {
        const response = await axiosGet(url)
        const data = response.data

        if (data != null && data.status == "pass" && data.links != null && data.links.about == "https://shlink.io") {
            await msgLog(ctx, `shlink health check passed`, telegram)
        } else {
            await errorLog(ctx, `error shlink health check`)
        }
    } catch (error) {
        await errorLog(ctx, `error fetch url ${url}`, error)
    }
}

async function healthCheck(ctx, telegram = false) {
    await checkShlinkStatus(ctx, telegram)
    await checkRedirectTable(ctx, telegram)
}

app.timer("shlink-health-check", {
    schedule: '0 0 * * * *',
    handler: async (myTimer, ctx) => {
        ctx.log("beginnen health check on shlink")
        await healthCheck(ctx, updateLastCodeGreen(ctx))
    }
})