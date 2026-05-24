// Popup UI logic

document.addEventListener('DOMContentLoaded', async () => {
  const videoList = document.getElementById('video-list');
  const countBadge = document.getElementById('count-badge');
  const refreshBtn = document.getElementById('refresh-btn');
  const clearBtn = document.getElementById('clear-btn');
  
  let currentTabId = null;
  
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  
  // Load videos
  loadVideos();
  
  // Event listeners
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.style.transform = 'rotate(360deg)';
    setTimeout(() => refreshBtn.style.transform = '', 500);
    
    // Rescan page
    await chrome.tabs.sendMessage(currentTabId, { action: 'rescan' });
    setTimeout(loadVideos, 1000);
  });
  
  clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({
      action: 'clearVideos',
      tabId: currentTabId
    });
    loadVideos();
  });
  
  async function loadVideos() {
    const response = await chrome.runtime.sendMessage({
      action: 'getVideos',
      tabId: currentTabId
    });
    
    const videos = response.videos || [];
    countBadge.textContent = videos.length;
    
    if (videos.length === 0) {
      videoList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          <p>No videos detected yet</p>
          <p class="sub">Play a video or refresh the page</p>
        </div>
      `;
      return;
    }
    
    videoList.innerHTML = '';
    
    // Sort by timestamp (newest first)
    videos.sort((a, b) => b.timestamp - a.timestamp);
    
    videos.forEach(video => {
      const item = createVideoItem(video);
      videoList.appendChild(item);
    });
  }
  
  function createVideoItem(video) {
    const div = document.createElement('div');
    div.className = 'video-item';
    div.dataset.videoId = video.id;
    
    const typeIcon = video.type === 'hls' ? '📡' : 
                    video.type === 'dash' ? '📊' : '🎬';
    
    const domain = video.domain || new URL(video.url).hostname;
    
    div.innerHTML = `
      <div class="video-header">
        <div class="video-icon">${typeIcon}</div>
        <div class="video-info">
          <div class="video-title" title="${escapeHtml(video.title || 'Untitled')}">
            ${escapeHtml(video.title || 'Untitled Video')}
          </div>
          <div class="video-meta">
            <span class="video-type">${video.type}</span>
            ${video.quality !== 'unknown' ? `<span class="video-quality">${video.quality}</span>` : ''}
            <span class="video-domain">${escapeHtml(domain)}</span>
          </div>
        </div>
      </div>
      <div class="video-actions">
        <button class="btn-download" data-action="download">
          ⬇️ Download
        </button>
        <button class="btn-copy" data-action="copy" title="Copy URL">
          📋
        </button>
      </div>
      <div class="progress-bar" style="display: none;">
        <div class="progress-fill"></div>
      </div>
    `;
    
    // Download button
    const downloadBtn = div.querySelector('[data-action="download"]');
    downloadBtn.addEventListener('click', async () => {
      downloadBtn.disabled = true;
      downloadBtn.textContent = '⏳ Starting...';
      
      await chrome.runtime.sendMessage({
        action: 'downloadVideo',
        videoId: video.id,
        tabId: currentTabId
      });
      
      downloadBtn.textContent = '✅ Queued';
      setTimeout(() => {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '⬇️ Download';
      }, 2000);
    });
    
    // Copy button
    const copyBtn = div.querySelector('[data-action="copy"]');
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(video.url);
      copyBtn.textContent = '✅';
      setTimeout(() => {
        copyBtn.textContent = '📋';
      }, 1500);
    });
    
    return div;
  }
  
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  // Listen for new videos detected while popup is open
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'videoDetected' && message.tabId === currentTabId) {
      loadVideos();
    }
  });
});