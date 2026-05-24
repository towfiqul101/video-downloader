// Background script - intercepts network requests and manages video registry

const videoRegistry = new Map(); // tabId -> array of video objects
const downloadProgress = new Map(); // downloadId -> progress info

// Intercept network requests to catch video streams
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    const tabId = details.tabId;
    
    if (tabId === -1) return;
    
    // Detect video/stream URLs
    const videoPatterns = [
      /\.(mp4|webm|ogg|mkv|avi|mov)(\?|$)/i,
      /\.m3u8(\?|$)/i,           // HLS manifest
      /\.mpd(\?|$)/i,            // DASH manifest
      /videoplayback\?/i,        // YouTube-style
      /manifest\./i,             // Generic manifest
      /playlist\.m3u8/i,
      /master\.m3u8/i
    ];
    
    const isVideo = videoPatterns.some(pattern => pattern.test(url));
    
    if (isVideo) {
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
      
      // Store per tab
      if (!videoRegistry.has(tabId)) {
        videoRegistry.set(tabId, []);
      }
      
      const videos = videoRegistry.get(tabId);
      // Avoid duplicates
      if (!videos.some(v => v.url === url)) {
        videos.push(videoInfo);
        
        // Notify popup if open
        chrome.runtime.sendMessage({
          action: 'videoDetected',
          tabId: tabId,
          video: videoInfo
        }).catch(() => {});
        
        // Update badge
        updateBadge(tabId);
      }
    }
  },
  { urls: ["<all_urls>"] },
  []
);

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'registerVideo':
      handleContentVideo(message.video, sender.tab?.id);
      sendResponse({ success: true });
      break;
      
    case 'getVideos':
      const tabId = message.tabId || sender.tab?.id;
      sendResponse({ videos: videoRegistry.get(tabId) || [] });
      break;
      
    case 'downloadVideo':
      downloadVideo(message.videoId, message.tabId, message.quality);
      sendResponse({ success: true });
      break;
      
    case 'downloadHLS':
      downloadHLSVideo(message.url, message.filename);
      sendResponse({ success: true });
      break;
      
    case 'clearVideos':
      videoRegistry.delete(message.tabId);
      updateBadge(message.tabId);
      sendResponse({ success: true });
      break;
      
    case 'getProgress':
      sendResponse({ progress: downloadProgress.get(message.downloadId) });
      break;
  }
  return true;
});

// Handle videos found by content script
function handleContentVideo(video, tabId) {
  if (!tabId) return;
  
  const videoInfo = {
    id: generateId(),
    url: video.url,
    type: video.type || 'direct',
    timestamp: Date.now(),
    size: video.size,
    title: video.title || document?.title,
    quality: video.quality || 'unknown',
    domain: new URL(video.url).hostname,
    pageUrl: video.pageUrl
  };
  
  if (!videoRegistry.has(tabId)) {
    videoRegistry.set(tabId, []);
  }
  
  const videos = videoRegistry.get(tabId);
  if (!videos.some(v => v.url === video.url)) {
    videos.push(videoInfo);
    updateBadge(tabId);
  }
}

// Download a video
async function downloadVideo(videoId, tabId, preferredQuality) {
  const videos = videoRegistry.get(tabId) || [];
  const video = videos.find(v => v.id === videoId);
  
  if (!video) return;
  
  const filename = sanitizeFilename(
    video.title || `video_${Date.now()}`
  ) + (video.type === 'hls' ? '.mp4' : getExtension(video.url));
  
  if (video.type === 'hls') {
    // For HLS, we need to process the manifest first
    await processHLSDownload(video.url, filename);
  } else {
    // Direct download
    chrome.downloads.download({
      url: video.url,
      filename: `VideoDownloads/${filename}`,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('Download failed:', chrome.runtime.lastError);
      } else {
        trackDownload(downloadId, video);
      }
    });
  }
}

// Process HLS stream
async function processHLSDownload(m3u8Url, filename) {
  try {
    const response = await fetch(m3u8Url);
    const manifest = await response.text();
    
    // Parse M3U8 to get segment URLs
    const segments = parseM3U8(manifest, m3u8Url);
    
    if (segments.length === 0) {
      console.error('No segments found in HLS manifest');
      return;
    }
    
    // For simplicity, download segments and provide a list
    // In production, you'd want to merge them with ffmpeg.wasm
    const segmentList = segments.join('\n');
    const blob = new Blob([segmentList], { type: 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);
    
    chrome.downloads.download({
      url: blobUrl,
      filename: `VideoDownloads/${filename}_segments.txt`,
      saveAs: false
    });
    
    // Also try to download the first segment as sample
    if (segments[0]) {
      chrome.downloads.download({
        url: segments[0],
        filename: `VideoDownloads/${filename}_sample.ts`,
        saveAs: false
      });
    }
    
  } catch (error) {
    console.error('HLS processing failed:', error);
  }
}

// Simple M3U8 parser
function parseM3U8(manifest, baseUrl) {
  const lines = manifest.split('\n');
  const segments = [];
  const base = new URL(baseUrl);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      // It's a segment URL
      if (trimmed.startsWith('http')) {
        segments.push(trimmed);
      } else {
        // Relative URL
        segments.push(new URL(trimmed, base).href);
      }
    }
  }
  
  return segments;
}

// Track download progress
function trackDownload(downloadId, video) {
  downloadProgress.set(downloadId, {
    video: video,
    startTime: Date.now(),
    status: 'downloading'
  });
  
  chrome.downloads.onChanged.addListener(function onChanged(delta) {
    if (delta.id === downloadId) {
      if (delta.state?.current === 'complete') {
        downloadProgress.get(downloadId).status = 'complete';
        chrome.downloads.onChanged.removeListener(onChanged);
      } else if (delta.error) {
        downloadProgress.get(downloadId).status = 'error';
        chrome.downloads.onChanged.removeListener(onChanged);
      }
    }
  });
}

// Update extension badge with video count
function updateBadge(tabId) {
  const videos = videoRegistry.get(tabId) || [];
  const count = videos.length;
  
  chrome.action.setBadgeText({
    text: count > 0 ? String(count) : '',
    tabId: tabId
  });
  
  chrome.action.setBadgeBackgroundColor({
    color: '#FF6B35'
  });
}

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  videoRegistry.delete(tabId);
});

// Utility functions
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function extractQuality(url) {
  const qualityPatterns = [
    /(\d{3,4})p/i,
    /(\d{3,4})x(\d{3,4})/,
    /quality[=/](\w+)/i,
    /res[=/](\d+)/i
  ];
  
  for (const pattern of qualityPatterns) {
    const match = url.match(pattern);
    if (match) return match[1] + 'p';
  }
  
  return 'unknown';
}

function getExtension(url) {
  const match = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  return match ? `.${match[1]}` : '.mp4';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:\"/\\|?*]+/g, '_').substring(0, 200);
}

// Handle tab updates - clear old videos when navigating
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    videoRegistry.delete(tabId);
    updateBadge(tabId);
  }
});