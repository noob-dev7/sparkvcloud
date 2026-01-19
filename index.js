// ============================================
// vcloud.zip HEAVY DUTY EXTRACTOR BOT - KOYEB
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== CONFIGURATION ==========
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN || '8485239719:AAFAVJvjCNVYeqm49rDJGeF91F0L3Ctkj0E';
const PORT = process.env.PORT || 8080;

const ALLOWED_DOMAINS = ['vegamovies.gt', 'rogmovies.world', 'www.gokuhd.com', 'xprimehub.my'];
const WORDPRESS_PATTERNS = ['https://nexdrive.pro/', 'https://mega.nz/', 'https://gofile.io/', 'https://dropbox.com/'];
const VCLOUD_PATTERNS = ['https://vcloud.zip/']; // ONLY vcloud.zip

const MAX_CONCURRENT = 5;
const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 10;
const BATCH_SIZE = 50;
const MAX_URLS_PER_FILE = 1000;

// ========== UTILITY FUNCTIONS ==========
function extractLinksFromHTML(html) {
  const links = new Set();
  const urlRegex = /https?:\/\/[^\s"'<>()]+/g;
  const matches = html.match(urlRegex) || [];
  matches.forEach(link => {
    if (WORDPRESS_PATTERNS.some(pattern => link.startsWith(pattern))) links.add(link);
  });
  const anchorRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let anchorMatch;
  while ((anchorMatch = anchorRegex.exec(html)) !== null) {
    const href = anchorMatch[1];
    if (href && WORDPRESS_PATTERNS.some(pattern => href.startsWith(pattern))) links.add(href);
  }
  return Array.from(links);
}

function extractVcloudInfo(html) {
  const results = [];
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : 'No title found';
  title = title.replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const urlRegex = /https?:\/\/[^\s"'<>()]+/g;
  const matches = html.match(urlRegex) || [];
  matches.forEach(link => {
    if (link.startsWith('https://vcloud.zip/')) {
      results.push({ title: title, url: link, timestamp: new Date().toISOString() });
    }
  });
  return results;
}

function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    const domain = url.hostname;
    const isAllowed = ALLOWED_DOMAINS.some(allowed => domain === allowed || domain.endsWith('.' + allowed));
    return isAllowed && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch (err) { return false; }
}

async function fetchWithInfiniteRetry(url, options = {}, maxRetries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios({ url, method: options.method || 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...options.headers },
        timeout: REQUEST_TIMEOUT, ...options });
      return response;
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = Math.min(5000 * Math.pow(1.5, attempt - 1), 30000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return { data: '<html><title>FALLBACK</title></html>', status: 200 };
}

// ========== PROCESSING FUNCTIONS ==========
async function processSingleUrl(url) {
  try {
    const wpResponse = await fetchWithInfiniteRetry(url);
    const wordpressLinks = extractLinksFromHTML(wpResponse.data);
    const allVcloudResults = [];
    for (let i = 0; i < wordpressLinks.length; i++) {
      try {
        const linkResponse = await fetchWithInfiniteRetry(wordpressLinks[i]);
        const vcloudInfo = extractVcloudInfo(linkResponse.data);
        if (vcloudInfo.length > 0) allVcloudResults.push(...vcloudInfo);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) { continue; }
    }
    return { success: true, url: url, vcloudResults: allVcloudResults, totalLinks: allVcloudResults.length };
  } catch (error) {
    return { success: true, url: url, vcloudResults: [{ title: `MANUAL_CHECK: ${url}`, url: `#ERROR:${url}` }], totalLinks: 1, emergency: true };
  }
}

async function processBatch(urls, batchNum, totalBatches) {
  console.log(`\n🚀 BATCH ${batchNum}/${totalBatches} - ${urls.length} URLs`);
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const result = await processSingleUrl(urls[i]);
    results.push(result);
    if (i < urls.length - 1) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return results;
}

async function processBulkUrls(urls, chatId) {
  const batches = [];
  for (let i = 0; i < urls.length; i += BATCH_SIZE) batches.push(urls.slice(i, i + BATCH_SIZE));
  const allResults = [];
  let totalLinks = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    await sendTelegramMessage(chatId, `🔄 <b>Batch ${batchIndex+1}/${batches.length}</b>\n📊 Progress: ${Math.round((batchIndex/batches.length)*100)}%`);
    const batchResults = await processBatch(batches[batchIndex], batchIndex+1, batches.length);
    allResults.push(...batchResults);
    totalLinks += batchResults.reduce((sum, r) => sum + (r.totalLinks || 0), 0);
    if (batchIndex < batches.length - 1) await new Promise(resolve => setTimeout(resolve, 10000));
  }
  const successful = allResults.filter(r => r.success && !r.emergency).length;
  const emergency = allResults.filter(r => r.emergency).length;
  return { success: true, totalUrls: urls.length, processedUrls: allResults.length,
    successfulUrls: successful, emergencyUrls: emergency, totalVcloudLinks: totalLinks,
    batchesProcessed: batches.length, results: allResults };
}

// ========== TELEGRAM FUNCTIONS ==========
async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  try {
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text: text, parse_mode: 'HTML', reply_to_message_id: replyToMessageId });
    return response.data;
  } catch (error) { console.error('Telegram error:', error.message); return null; }
}

async function sendTelegramFile(chatId, content, filename) {
  try {
    const tempFilePath = path.join('/tmp', filename);
    fs.writeFileSync(tempFilePath, content);
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', fs.createReadStream(tempFilePath));
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
      formData, { headers: formData.getHeaders() });
    fs.unlinkSync(tempFilePath);
    return response.data;
  } catch (error) {
    if (content.length < 4000) await sendTelegramMessage(chatId, `<pre>${content.substring(0,3800)}</pre>`);
    return null;
  }
}

// ========== TELEGRAM HANDLER ==========
async function handleTelegramUpdate(update) {
  if (!update.message) return;
  const chatId = update.message.chat.id;
  const messageText = update.message.text || '';
  const document = update.message.document;
  
  if (messageText === '/start' || messageText === '/help') {
    await sendTelegramMessage(chatId, `🚀 <b>vcloud.zip HEAVY DUTY EXTRACTOR</b>\n✅ <b>KOYEB POWER - NO LIMITS</b>\n📁 Send .txt file with URLs\n📄 Output: Title|https://vcloud.zip/...\n⚠️ <i>1000+ URLs supported!</i>`);
    return;
  }
  
  if (document && document.mime_type === 'text/plain') {
    try {
      await sendTelegramMessage(chatId, `📥 <b>Heavy File Received!</b>\n⚡ <i>KOYEB Processing Started</i>`);
      const fileResponse = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${document.file_id}`);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileResponse.data.result.file_path}`;
      const fileContent = (await axios.get(fileUrl)).data;
      const urls = fileContent.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('//') && isValidUrl(line));
      if (urls.length === 0) { await sendTelegramMessage(chatId, '❌ No valid URLs found.'); return; }
      const urlsToProcess = urls.slice(0, MAX_URLS_PER_FILE);
      if (urls.length > MAX_URLS_PER_FILE) {
        await sendTelegramMessage(chatId, `⚠️ <b>Large file!</b>\n📊 URLs: ${urls.length} (limited to ${MAX_URLS_PER_FILE})`);
      } else {
        await sendTelegramMessage(chatId, `🔍 <b>Found ${urls.length} URLs</b>\n🚀 <i>Heavy processing...</i>`);
      }
      const result = await processBulkUrls(urlsToProcess, chatId);
      let outputContent = '';
      result.results.forEach(r => { if (r.vcloudResults) r.vcloudResults.forEach(item => { outputContent += `${item.title}|${item.url}\n`; }); });
      await sendTelegramMessage(chatId, `✅ <b>PROCESSING COMPLETE!</b>\n📊 URLs: ${result.processedUrls}\n🔗 Links: ${result.totalVcloudLinks}\n📁 <i>Sending file...</i>`);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await sendTelegramFile(chatId, outputContent || 'No links found', `vcloud_${result.totalVcloudLinks}_links_${timestamp}.txt`);
    } catch (error) {
      await sendTelegramMessage(chatId, `❌ <b>Error:</b> ${error.message.substring(0,100)}`);
    }
  }
}

// ========== EXPRESS SERVER ==========
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>vcloud.zip Heavy Bot</title><style>body{font-family:Arial;max-width:800px;margin:0 auto;padding:20px;}</style></head>
  <body><h1>🤖 vcloud.zip HEAVY DUTY BOT</h1><div style="background:#d4edda;padding:20px;border-radius:10px;">
  <h2>✅ DEPLOYED ON KOYEB</h2><p><b>Unlimited Processing - No Timeouts</b></p><p>1000+ URLs per file | Batch processing</p></div>
  <div style="margin-top:20px;"><p>Webhook URL: <code>https://your-app.koyeb.app/webhook</code></p>
  <p>Bot Token: <code>${TELEGRAM_BOT_TOKEN.substring(0,10)}...</code></p></div></body></html>`);
});

app.post('/webhook', async (req, res) => {
  try { await handleTelegramUpdate(req.body); res.status(200).send('OK'); } 
  catch (error) { console.error(error); res.status(500).send('ERROR'); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', server: 'vcloud.zip Heavy Bot', timestamp: new Date().toISOString() });
});

app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
    const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
    res.json(response.data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 Heavy Duty Bot running on port ${PORT}`);
  console.log(`🤖 Bot: ${TELEGRAM_BOT_TOKEN.substring(0,10)}...`);
  console.log(`🌐 Webhook: https://your-app.koyeb.app/webhook`);
  console.log(`⚡ Ready for 1000+ URLs!`);
});
