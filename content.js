// Content script - scans page for video elements and media sources

(function() {
  'use strict';
  
  const detectedVideos = new Set();
  
  // Initial scan
  scanForVideos();
  
  // Watch for dynamically added videos
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      setTimeout(scanForVideos, 500);
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Also scan periodically for lazy-loaded content
  setInterval(scanForVideos, 3000);
  
  function scanForVideos() {
    // Method 1: Find <video> elements
    const videoElements = document.querySelectorAll('video');
    videoElements.forEach(video => {
      const src = video.currentSrc || video.src;
      if (src && !detectedVideos.has(src)) {
        detectedVideos.add(src);
        registerVideo({
          url: src,
          type: 'direct',
          title: getVideoTitle(video),
          quality: getVideoQuality(video),
          size: null,
          pageUrl: location.href
        });
      }
      
      // Check for source children
      const sources = video.querySelectorAll('source');
      sources.forEach(source => {
        if (source.src && !detectedVideos.has(source.src)) {
          detectedVideos.add(source.src);
          registerVideo({
            url: source.src,
            type: 'direct',
            title: getVideoTitle(video),
            quality: source.getAttribute('data-quality') || getVideoQuality(video),
            size: null,
            pageUrl: location.href
          });
        }
      });
    });
    
    // Method 2: Find common video player containers
    const playerSelectors = [
      '.video-js',
      '.plyr',
      '.jwplayer',
      '[data-video-id]',
      '[id*="player"]',
      '[class*="player"]'
    ];
    
    playerSelectors.forEach(selector => {
      const players = document.querySelectorAll(selector);
      players.forEach(player => {
        // Try to extract data attributes
        const dataSrc = player.getAttribute('data-src') || 
                       player.getAttribute('data-video') ||
                       player.getAttribute('data-url');
        if (dataSrc && !detectedVideos.has(dataSrc)) {
          detectedVideos.add(dataSrc);
          registerVideo({
            url: resolveUrl(dataSrc),
            type: detectType(dataSrc),
            title: getVideoTitle(player),
            quality: 'unknown',
            pageUrl: location.href
          });
        }
      });
    });
    
    // Method 3: Hook into common player APIs
    hookVideoPlayers();
    
    // Method 4: Look for JSON-LD structured data
    findStructuredData();
    
    // Method 5: Check window variables for video URLs
    findWindowVideoVars();
  }
  
  function registerVideo(videoInfo) {
    chrome.runtime.sendMessage({
      action: 'registerVideo',
      video: videoInfo
    }).catch(err => {
      // Extension might not be ready
      console.log('Failed to register video:', err);
    });
  }
  
  function getVideoTitle(element) {
    // Try multiple strategies to find title
    const strategies = [
      () => document.querySelector('h1')?.textContent,
      () => document.title,
      () => element.getAttribute('data-title'),
      () => element.getAttribute('aria-label'),
      () => {
        const container = element.closest('[class*="title"], [id*="title"]');
        return container?.textContent;
      },
      () => {
        const figcaption = element.closest('figure')?.querySelector('figcaption');
        return figcaption?.textContent;
      }
    ];
    
    for (const strategy of strategies) {
      const title = strategy();
      if (title) return title.trim().substring(0, 200);
    }
    
    return `Video_${Date.now()}`;
  }
  
  function getVideoQuality(video) {
    if (video.videoWidth && video.videoHeight) {
      return `${video.videoHeight}p`;
    }
    return 'unknown';
  }
  
  function resolveUrl(url) {
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return location.protocol + url;
    if (url.startsWith('/')) return location.origin + url;
    return new URL(url, location.href).href;
  }
  
  function detectType(url) {
    if (url.includes('.m3u8')) return 'hls';
    if (url.includes('.mpd')) return 'dash';
    return 'direct';
  }
  
  function hookVideoPlayers() {
    // Hook Video.js
    if (window.videojs) {
      const original = window.videojs;
      window.videojs = function(...args) {
        const player = original.apply(this, args);
        player.ready(() => {
          const src = player.currentSrc();
          if (src && !detectedVideos.has(src)) {
            detectedVideos.add(src);
            registerVideo({
              url: src,
              type: detectType(src),
              title: getVideoTitle(document.querySelector('.video-js')),
              quality: 'unknown',
              pageUrl: location.href
            });
          }
        });
        return player;
      };
    }
    
    // Hook HTML5 video prototype
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      const src = this.currentSrc || this.src;
      if (src && !detectedVideos.has(src)) {
        detectedVideos.add(src);
        registerVideo({
          url: src,
          type: 'direct',
          title: getVideoTitle(this),
          quality: getVideoQuality(this),
          pageUrl: location.href
        });
      }
      return originalPlay.apply(this, arguments);
    };
  }
  
  function findStructuredData() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach(script => {
      try {
        const data = JSON.parse(script.textContent);
        const videos = Array.isArray(data) ? data : [data];
        
        videos.forEach(item => {
          if (item['@type'] === 'VideoObject' && item.contentUrl) {
            const url = item.contentUrl;
            if (!detectedVideos.has(url)) {
              detectedVideos.add(url);
              registerVideo({
                url: url,
                type: 'direct',
                title: item.name || document.title,
                quality: item.videoQuality || 'unknown',
                pageUrl: location.href
              });
            }
          }
        });
      } catch (e) {
        // Invalid JSON
      }
    });
  }
  
  function findWindowVideoVars() {
    // Common variable names used by sites
    const varNames = [
      'videoUrl', 'videoSrc', 'mediaUrl', 'streamUrl',
      'playerConfig', 'videoData', 'mediaData'
    ];
    
    varNames.forEach(name => {
      try {
        if (window[name]) {
          const data = window[name];
          if (typeof data === 'string' && data.startsWith('http')) {
            if (!detectedVideos.has(data)) {
              detectedVideos.add(data);
              registerVideo({
                url: data,
                type: detectType(data),
                title: document.title,
                quality: 'unknown',
                pageUrl: location.href
              });
            }
          } else if (typeof data === 'object') {
            // Try to extract URLs from object
            extractUrlsFromObject(data);
          }
        }
      } catch (e) {}
    });
  }
  
  function extractUrlsFromObject(obj, depth = 0) {
    if (depth > 5) return;
    
    for (const key in obj) {
      const value = obj[key];
      if (typeof value === 'string' && value.startsWith('http')) {
        if ((value.includes('.mp4') || value.includes('.m3u8') || 
             value.includes('.webm') || value.includes('video')) &&
            !detectedVideos.has(value)) {
          detectedVideos.add(value);
          registerVideo({
            url: value,
            type: detectType(value),
            title: document.title,
            quality: 'unknown',
            pageUrl: location.href
          });
        }
      } else if (typeof value === 'object' && value !== null) {
        extractUrlsFromObject(value, depth + 1);
      }
    }
  }
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'rescan') {
      detectedVideos.clear();
      scanForVideos();
      sendResponse({ success: true });
    }
    return true;
  });
  
})();