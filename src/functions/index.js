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

function telegramMessage(msg) {
    bot.sendMessage(process.env.TELEGRAM_GROUP_ID, msg, { disable_web_page_preview: true })
}

function errorLog(ctx, msg, error = null) {
    ctx.log(msg)
    if (error)
        ctx.log(error)
    telegramMessage(`${redCross} ${msg}`)
}

function msgLog(ctx, msg) {
    ctx.log(msg)
    if (lastCodeGreen + process.env.TELEGRAM_CODE_GREEN_CYCLE < Date.now()) {
        telegramMessage(`${greenCheck} ${msg}`)
    }

}

function updateLastCodeGreen() {
    if (lastCodeGreen + process.env.TELEGRAM_CODE_GREEN_CYCLE < Date.now()) {
        lastCodeGreen = Date.now()
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

async function checkRedirectTable(ctx) {
    for (const entry of redirectTable) {
        const url = serverUrl + "/" + entry.suffix
        try {
            const response = await axiosGet(serverUrl + "/" + entry.suffix)

            if (response.status == 302 && response.headers.location == entry.redirect) {
                msgLog(ctx, `successful checked url ${url} -> ${entry.redirect}`)
            } else {
                errorLog(ctx, `error checking url ${url}`)
                errorLog(ctx, `response status = ${response.status}`)
                errorLog(ctx, `${response.headers.location} ?= ${entry.redirect}`)
            }
        } catch (error) {
            errorLog(ctx, `error fetch url ${url}`, error)
        }
    }
}

async function checkShlinkStatus(ctx) {
    const url = serverUrl + "/rest/health"
    try {
        const response = await axiosGet(url)
        const data = response.data

        if (data != null && data.status == "pass" && data.links != null && data.links.about == "https://shlink.io") {
            msgLog(ctx, `shlink health check passed`)
        } else {
            errorLog(ctx, `error shlink health check`)
        }
    } catch (error) {
        errorLog(ctx, `error fetch url ${url}`, error)
    }
}

async function healthCheck(ctx) {
    await checkShlinkStatus(ctx)
    await checkRedirectTable(ctx)
    updateLastCodeGreen()
}

app.timer("shlink-health-check", {
    schedule: '0 0 * * * *',
    handler: async (myTimer, ctx) => {
        ctx.log("beginnen health check on shlink")
        ctx.log(`lastCodeGreen ${lastCodeGreen}`)
        ctx.log("Date.now() " + Date.now())
        ctx.log("process.env.TELEGRAM_CODE_GREEN_CYCLE " + process.env.TELEGRAM_CODE_GREEN_CYCLE)
        await healthCheck(ctx)
    }
})
