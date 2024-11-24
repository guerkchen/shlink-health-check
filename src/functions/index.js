const axios = require("axios")
const TelegramBot = require("node-telegram-bot-api")
const { app } = require('@azure/functions');
require("dotenv").config()

const greenCheck = '\u2705'; // ✅
const redCross = '\u274C';  // ❌
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

var lastCodeGreen = 0;

function telegramMessage(msg) {
    bot.sendMessage(process.env.TELEGRAM_GROUP_ID, msg)
}

async function fetchData(url) {
    console.log(`fetchData ${url}`)
    var response;
    try {
        response = await axios.get(url)
    } catch (error) {
        console.error(`cannot fetch data from url ${url}`)
        console.error(error)
        telegramMessage(`${redCross} cannot fetch data from ${url}`)
        return null
    }
    return response.data
}

async function healthCheck() {
    const server = process.env.SHLINK_URL
    const url = server + "/rest/health"
    console.log(`checkServerStatus ${url}`)

    const data = await fetchData(url)
    if (data != null && data.status == "pass" && data.links != null && data.links.about == "https://shlink.io") {
        console.log(`shlink health check passed`)
        if (lastCodeGreen + process.env.TELEGRAM_CODE_GREEN_CYCLE < Date.now()) {
            lastCodeGreen = Date.now()
            telegramMessage(`${greenCheck} shlink health check passed`)
        }
    } else {
        console.error(`error health check ${data}`)
        telegramMessag(`${redCross} error health check`)
    }

    firstRun = false
}

app.timer("shlink-health-check", {
    schedule: '0 0 * * * *',
    handler: (myTimer, context) => {
        context.log("beginnen health check on shlink")
        healthCheck()
    }
})

healthCheck()
