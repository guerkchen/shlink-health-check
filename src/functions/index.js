const axios = require("axios")
const TelegramBot = require("node-telegram-bot-api")
const { app } = require('@azure/functions');
const { TableClient } = require("@azure/data-tables");
require("dotenv").config()

const greenCheck = '\u2705'; // ✅
const yellowWarning = "\u26A0\uFE0F"; // ⚠️
const redCross = '\u274C';  // ❌
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

var storageClient = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING, tableName = "shlinkHealthCheckTable");
const partitionKey = "shlinkHealthCheckPartitionKey"
const rowKeyCodeGreen = "codeGreenRowKey"
const rowKeyForward = "forwardRowKey"

// TelegramBot won't send to many messages in short term. That's why we collect messages and send them by less big chunks.
// Futhermore we make sure to wait a short amount of time betweens sending of messages
var telegramMessageStore = ""
var lastTelegramMessageSend = 0

async function telegramMessageSend(ctx) {
    var durationToNextSend = parseInt(lastTelegramMessageSend) + parseInt(process.env.TELEGRAM_MIN_DURATION_BETWEEN_MESSAGES) - Date.now()
    if (durationToNextSend > 0) {
        await new Promise(resolve => setTimeout(resolve, durationToNextSend)); // sleep until next send
    }

    try {
        await bot.sendMessage(process.env.TELEGRAM_GROUP_ID, telegramMessageStore, { disable_web_page_preview: true })
    } catch (error) {
        ctx.log("error sending message to telegram")
        ctx.log(error)
    }

    telegramMessageStore = ""
}

async function telegramMessage(ctx, msg) {
    if (telegramMessageStore.length != 0 && telegramMessageStore.length + msg.length + 1 > process.env.TELEGRAM_MAX_MESSAGE_SIZE) { // no space for new message
        // send collected messages
        telegramMessageSend(ctx)
    }

    if (telegramMessageStore.length == 0 && msg.length + 1 > process.env.TELEGRAM_MAX_MESSAGE_SIZE) { // message is to big for one chunk
        // message gets shortend
        telegramMessageStore = msg.substring(0, process.env.TELEGRAM_MAX_MESSAGE_SIZE - 6) + " [...]"
        telegramMessageSend(ctx)
    } else if (telegramMessageStore.length == 0) { // append message
        telegramMessageStore = msg
    } else {
        telegramMessageStore += "\n" + msg
    }
}

async function errorLog(ctx, msg, error = null) {
    ctx.log(msg)
    if (error)
        ctx.log(error)
    await telegramMessage(ctx, `${redCross} ${msg}`)
}

async function warnLog(ctx, msg) {
    ctx.log(msg)
    await telegramMessage(ctx, `${yellowWarning} ${msg}`)
}

async function msgLog(ctx, msg, telegram = false) {
    ctx.log(msg)
    if (telegram) {
        await telegramMessage(ctx, `${greenCheck} ${msg}`)
    }
}

async function initializeTable(ctx) { // Create table if not exists
    try {
        storageClient = TableClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING, tableName = "shlinkHealthCheckTable");
        await storageClient.createTable();
        await ctx.log(`Table ${tableName} created or already exists.`);
    } catch (err) {
        await ctx.log(`Table creation error: ${err.message}`);
    }
}

async function updateLastCodeGreen(ctx) {
    var entity
    try {
        entity = await storageClient.getEntity(partitionKey, rowKeyCodeGreen); // read lastCodeGreen
    } catch (err) {
        await errorLog(ctx, "error updateLastCodeGreen getEntity", err.message)
        entity = { // maybe there is no entry for lastCodeGreen
            "partitionKey": partitionKey,
            "rowKey": rowKeyCodeGreen,
            lastCodeGreen: 0
        }
    }

    if (parseInt(entity.lastCodeGreen) + parseInt(process.env.TELEGRAM_CODE_GREEN_CYCLE) < Date.now()) {
        console.log(entity)
        entity.lastCodeGreen = Date.now();

        try {
            await storageClient.upsertEntity(entity, "Replace"); // write lastCodeGreen
            await ctx.log("lastCodeGreen updated successfully.");
        } catch (err) {
            await errorLog(ctx, "error updateLastCodeGreen updateEntity", err.message)
        }

        return true
    } else {
        return false
    }
}

async function compareForward(ctx, oldForward, newForward, telegram = false) {
    // Search for new Forwards and changed forwards
    for (const key of Object.keys(newForward)) {
        if (oldForward[key] == null) {
            // forward was not present last time
            await warnLog(ctx, `new forward ${key} detected`) // code yellow
        } else {
            await msgLog(ctx, `forward ${key} found`, telegram) // code green

            // now check if forward still points to the same url
            if (newForward[key] != oldForward[key]) {
                await warnLog(ctx, `forward of ${key} changed (old: ${oldForward[key]}, new: ${newForward[key]})`) // code red
            } else {
                await msgLog(ctx, `forward website ${key} unchanged (${newForward[key]})`, telegram) // code green
            }
        }
    }

    // Search for deleted Forwards
    for (const key of Object.keys(oldForward)) {
        if (newForward[key] == null) {
            await errorLog(ctx, `old forward ${key} deleted`) // code red
        } // no code green here, since all links are listed when newForward is parsed
    }
}

async function compareAndReplaceOldForward(ctx, newForward, telegram = false) {
    var oldEntity
    try {
        oldEntity = await storageClient.getEntity(partitionKey, rowKeyForward);
    } catch (err) {
        await errorLog(ctx, "error getAndReplaceForward getEntity", err.message)
        oldEntity = {
            "partitionKey": partitionKey,
            "rowKey": rowKeyForward
        }
    }

    oldForward = {}
    var i = 0
    while (true) {
        if (oldEntity["shortUrl" + i] == null || oldEntity["longUrl" + i] == null) {
            break
        } else {
            oldForward[oldEntity["shortUrl" + i]] = oldEntity["longUrl" + i]
            i++
        }
    }

    await compareForward(ctx, oldForward, newForward, telegram)

    const newEntity = {
        "partitionKey": partitionKey,
        "rowKey": rowKeyForward
        // shortUrl0: 'https://abc.de/abasd',
        // longUrl0: 'https://www.google.de',
        // ...
    }
    var i = 0
    for (var key of Object.keys(newForward)) { // this design is necessary, since no specials chars are allowed in the key value
        newEntity["shortUrl" + i] = key
        newEntity["longUrl" + i] = newForward[key]
        i++
    }

    try {
        await storageClient.upsertEntity(newEntity); // Upsert (update oder insert)
    } catch (err) {
        await errorLog(ctx, "error getAndReplaceForward upsertEntity", err.message)
    }
}

async function getNewForward(ctx) {
    var newForward = {}
    var currentPage = 1
    while (true) { // break when last page is parsed
        const requestUrl = process.env.SHLINK_URL + `/rest/v3/short-urls?page=${currentPage}&itemsPerPage=10&tags%5B%5D=use%3Aprod&tagsMode=all`
        try {
            const response = await axios({
                url: requestUrl,
                headers: {
                    'accept': 'application/json',
                    'X-Api-Key': process.env.SHLINK_API_KEY
                },
                method: `get`,
                timeout: 20000
            })
            const data = response.data
            if (data.shortUrls == null || data.shortUrls.data == null || data.shortUrls.pagination == null || data.shortUrls.pagination.pagesCount == null) { // check for valid data
                await errorLog(ctx, "error get list of urls", data)
                break // cannot continue
            } else {
                for (const forwardUrlData of data.shortUrls.data) {
                    if (forwardUrlData.shortUrl == null || forwardUrlData.longUrl == null) { // check for valid data
                        await errorLog(ctx, "shortUrl or longUrl is not here", forwardUrlData)
                    } else {
                        newForward[forwardUrlData.shortUrl] = forwardUrlData.longUrl // add entry to newForward
                    }
                }

                if (data.shortUrls.pagination.pagesCount == currentPage) {
                    break // all pages parsed
                } else {
                    currentPage++
                }
            }
        } catch (error) {
            await errorLog(ctx, `error getNewForward fetch ${requestUrl}`, error)
        }
    }

    return newForward
}

async function checkRedirect(ctx, shortUrl, longUrl, telegram = false) {
    // check for correct forwarding
    try {
        const response = await axios({
            url: shortUrl,
            method: `get`,
            timeout: 20000,
            maxRedirects: 0,
            validateStatus: (status) =>
                status >= 200 && status < 400,
        })

        if (response.status == 302 && response.headers.location == longUrl) {
            await msgLog(ctx, `successful checked url ${shortUrl} -> ${longUrl}`, telegram)
        } else {
            await errorLog(ctx, `error checkRedirect ${shortUrl}, response status = ${response.status}, ${response.headers.location} ?= ${longUrl}`)
        }
    } catch (error) {
        await errorLog(ctx, `error checkRedirect shortUrl fetch ${shortUrl}`, error)
    }

    // check forwarding to be reachable
    try {
        await axios({
            url: longUrl,
            method: `get`,
            timeout: 20000,
            validateStatus: (status) =>
                status >= 200 && status < 300 || status == 403, // some website prohibit searching with axios, so unfortunately we must accept 403 here
        })

        await msgLog(ctx, `successful reached ${longUrl}`, telegram)
    } catch (error) {
        await errorLog(ctx, `error checkRedirect longUrl fetch ${longUrl}`, error)
    }
}

async function checkRedirects(ctx, newForward, telegram) {
    for (var shortUrl of Object.keys(newForward)) {
        await checkRedirect(ctx, shortUrl, newForward[shortUrl], telegram)
    }
}

async function checkShlinkStatus(ctx, telegram = false) {
    const healthUrl = process.env.SHLINK_URL + "/rest/health"
    try {
        const response = await axios({
            url: healthUrl,
            method: `get`,
            timeout: 20000,
        })
        const data = response.data

        if (data != null && data.status == "pass" && data.links != null && data.links.about == "https://shlink.io") {
            await msgLog(ctx, `shlink health check passed`, telegram)
        } else {
            await errorLog(ctx, `error shlink health check`)
        }
    } catch (error) {
        await errorLog(ctx, `error checkShlinkStatus fetch ${healthUrl}`, error)
    }
}

async function healthCheck(ctx) {
    const telegram = await updateLastCodeGreen(ctx)
    await initializeTable(ctx)
    await checkShlinkStatus(ctx, telegram)
    const newForward = await getNewForward(ctx)
    await compareAndReplaceOldForward(ctx, newForward, telegram)
    await checkRedirects(ctx, newForward, telegram)

    if (telegramMessageStore.length != 0) { // only need to send if there is data
        await telegramMessageSend(ctx)
    }
}

app.timer("shlink-health-check", {
    schedule: '0 0 * * * *',
    handler: async (myTimer, ctx) => {
        await ctx.log("beginnen health check on shlink")
        await healthCheck(ctx)
    }
})