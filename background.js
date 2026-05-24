// background.js

// Import the HLS parser library you created
importScripts('lib/hls-parser.js');

const videoRegistry = new Map();
const downloadProgress = new Map();

// Intercept network requests to catch video streams
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;
    
    if (tabId === -1) return;
    
    const videoPatterns = [
      /\.(mp4|webm|ogg|mkv|avi|mov)(\?|$)/i,
      /\.m3u8(\?|$)/i,
      /\.mpd(\?|$)/i,
      /videoplayback\?/i,
      /manifest\./i,
      /playlist\.m3u8/i,
      /master\.m3u8/i
    ];
    
    if (videoPatterns.some(pattern => pattern.test(url))) {
      const videoType = url.match(/\.m3u8/i) ? 'hls' :
                       url.match(/\.mpd/i) ? 'dash' : 'direct';
      
      const videoInfo = {
        id: generateId(),
        url: url,
        type: videoType,
        timestamp: Date.now(),
        size: null,
        title: null,
        quality: extractQuality(url),
        domain: new URL(url).hostname
      };
      
      if (!videoRegistry.has(tabId)) videoRegistry.set(tabId, []);
      
      const videos = videoRegistry.get(tabId);
      if (!videos.some(v => v.url === url)) {
        videos.push(videoInfo);
        chrome.runtime.sendMessage({ action: 'videoDetected', tabId: tabId, video: videoInfo }).catch(() => {});
        updateBadge(tabId);
      }
    }
  },
  { urls: ["<all_urls>"] },
  []
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'registerVideo':
      handleContentVideo(message.video, sender.tab?.id);
      sendResponse({ success: true });
      break;
    case 'getVideos':
      sendResponse({ videos: videoRegistry.get(message.tabId || sender.tab?.id) || [] });
      break;
    case 'downloadVideo':
      downloadVideo(message.videoId, message.tabId, message.quality);
      sendResponse({ success: true });
      break;
    case 'clearVideos':
      videoRegistry.delete(message.tabId);
      updateBadge(message.tabId);
      sendResponse({ success: true });
      break;
  }
  return true;
});

function handleContentVideo(video, tabId) {
  if (!tabId) return;
  const videoInfo = {
    id: generateId(),
    url: video.url,
    type: video.type || 'direct',
    timestamp: Date.now(),
    size: video.size,
    title: video.title || 'Extracted Video',
    quality: video.quality || 'unknown',
    domain: new URL(video.url).hostname,
    pageUrl: video.pageUrl
  };
  
  if (!videoRegistry.has(tabId)) videoRegistry.set(tabId, []);
  
  const videos = videoRegistry.get(tabId);
  if (!videos.some(v => v.url === video.url)) {
    videos.push(videoInfo);
    updateBadge(tabId);
  }
}

async function downloadVideo(videoId, tabId, preferredQuality) {
  const videos = videoRegistry.get(tabId) || [];
  const video = videos.find(v => v.id === videoId);
  
  if (!video) return;
  
  const filename = sanitizeFilename(video.title || `video_${Date.now()}`);
  
  if (video.type === 'hls') {
    // Pass to our new proper HLS merger
    await processHLSDownload(video.url, filename);
  } else {
    chrome.downloads.download({
      url: video.url,
      filename: `VideoDownloads/${filename}${getExtension(video.url)}`,
      saveAs: false
    });
  }
}

// Fixed HLS Processor: Merges segments into a single playable file
async function processHLSDownload(m3u8Url, filename) {
  try {
    // Use the class from lib/hls-parser.js
    const parser = new HLSParser(); 
    const result = await parser.getAllSegmentUrls(m3u8Url);
    const segments = result.segments;

    if (!segments || segments.length === 0) {
      console.error('No segments found in HLS manifest');
      return;
    }

    // Optional: Notify user that merging has started (takes time)
    console.log(`Starting download and merge of ${segments.length} segments...`);

    const buffers = [];
    for (let i = 0; i < segments.length; i++) {
      try {
        const response = await fetch(segments[i]);
        const arrayBuffer = await response.arrayBuffer();
        buffers.push(arrayBuffer);
      } catch (err) {
        console.warn(`Failed to fetch segment ${i}, skipping...`);
      }
    }

    // Merge all TS binary chunks into one Blob
    const mergedBlob = new Blob(buffers, { type: 'video/mp2t' });
    const blobUrl = URL.createObjectURL(mergedBlob);
    
    chrome.downloads.download({
      url: blobUrl,
      filename: `VideoDownloads/${filename}.ts`, // Save as standard MPEG-TS
      saveAs: false
    });

  } catch (error) {
    console.error('HLS processing failed:', error);
  }
}

function updateBadge(tabId) {
  const count = (videoRegistry.get(tabId) || []).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId: tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
}

chrome.tabs.onRemoved.addListener(tabId => videoRegistry.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    videoRegistry.delete(tabId);
    updateBadge(tabId);
  }
});

function generateId() { return Math.random().toString(36).substring(2, 15); }
function extractQuality(url) {
  const match = url.match(/(\d{3,4})p/i) || url.match(/(\d{3,4})x(\d{3,4})/);
  return match ? match[1] + 'p' : 'unknown';
}
function getExtension(url) {
  const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? `.${match[1]}` : '.mp4';
}
function sanitizeFilename(name) {
  return name.replace(/[<>:\"/\\|?*]+/g, '_').substring(0, 100);
}
