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

function errorLog(msg, error = null) {
    console.error(msg)
    if (error)
        console.error(error)
    telegramMessage(`${redCross} ${msg}`)
}

function msgLog(msg) {
    console.log(msg)
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
    console.log(`axios.get ${requestUrl}`)
    return await axios({
        url: requestUrl,
        method: `get`,
        timeout: 20000,
        maxRedirects: 0,
        validateStatus: (status) =>
            status >= 200 && status < 400,
    })
}

async function checkRedirectTable() {
    console.log(`checkRedirectTable`)
    for (const entry of redirectTable) {
        const url = serverUrl + "/" + entry.suffix
        try {
            const response = await axiosGet(serverUrl + "/" + entry.suffix)

            if (response.status == 302 && response.headers.location == entry.redirect) {
                msgLog(`successful checked url ${url} -> ${entry.redirect}`)
            } else {
                errorLog(`error checking url ${url}`)
                errorLog(`response status = ${response.status}`)
                errorLog(`${response.headers.location} ?= ${entry.redirect}`)
            }
        } catch (error) {
            errorLog(`error fetch url ${url}`, error)
        }
    }
}

async function checkShlinkStatus() {
    console.log(`checkShlinkStatus`)
    const url = serverUrl + "/rest/health"
    try {
        const response = await axiosGet(url)
        const data = response.data

        if (data != null && data.status == "pass" && data.links != null && data.links.about == "https://shlink.io") {
            msgLog(`shlink health check passed`)
        } else {
            errorLog(`error shlink health check`)
        }
    } catch (error) {
        errorLog(`error fetch url ${url}`, error)
    }
}

async function healthCheck() {
    await checkShlinkStatus()
    await checkRedirectTable()
    updateLastCodeGreen()
}

app.timer("shlink-health-check", {
    schedule: '0 0 * * * *',
    handler: (myTimer, context) => {
        context.log("beginnen health check on shlink")
        healthCheck()
    }
})

healthCheck()
