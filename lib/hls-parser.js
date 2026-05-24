/**
 * Lightweight HLS/M3U8 Manifest Parser
 * Parses master playlists and media playlists to extract stream info
 */

class HLSParser {
  constructor() {
    this.baseUrl = '';
  }

  /**
   * Parse an M3U8 manifest string
   * @param {string} manifest - Raw M3U8 content
   * @param {string} baseUrl - Base URL for resolving relative paths
   * @returns {Object} Parsed manifest data
   */
  parse(manifest, baseUrl) {
    this.baseUrl = baseUrl;
    const lines = manifest.trim().split('\n').map(l => l.trim()).filter(l => l);
    
    if (!lines[0].includes('#EXTM3U')) {
      throw new Error('Invalid M3U8: Missing #EXTM3U header');
    }

    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
    
    if (isMaster) {
      return this.parseMasterPlaylist(lines);
    } else {
      return this.parseMediaPlaylist(lines);
    }
  }

  /**
   * Parse master playlist (contains multiple quality variants)
   */
  parseMasterPlaylist(lines) {
    const variants = [];
    let currentVariant = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-STREAM-INF')) {
        currentVariant = {
          attributes: this.parseAttributes(line),
          url: null
        };
      } else if (currentVariant && !line.startsWith('#')) {
        currentVariant.url = this.resolveUrl(line);
        variants.push(currentVariant);
        currentVariant = null;
      }
    }

    // Sort by bandwidth (highest first)
    variants.sort((a, b) => {
      const bwA = parseInt(a.attributes['BANDWIDTH'] || 0);
      const bwB = parseInt(b.attributes['BANDWIDTH'] || 0);
      return bwB - bwA;
    });

    return {
      type: 'master',
      variants: variants.map(v => ({
        url: v.url,
        bandwidth: parseInt(v.attributes['BANDWIDTH'] || 0),
        resolution: v.attributes['RESOLUTION'] || null,
        codecs: v.attributes['CODECS'] || null,
        frameRate: parseFloat(v.attributes['FRAME-RATE'] || 0),
        audio: v.attributes['AUDIO'] || null,
        video: v.attributes['VIDEO'] || null
      }))
    };
  }

  /**
   * Parse media playlist (contains actual segments)
   */
  parseMediaPlaylist(lines) {
    const segments = [];
    const metadata = {
      targetDuration: 0,
      mediaSequence: 0,
      playlistType: null,
      encryption: null,
      map: null
    };

    let currentSegment = null;
    let discontinuity = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Global tags
      if (line.startsWith('#EXT-X-TARGETDURATION')) {
        metadata.targetDuration = parseFloat(line.split(':')[1]);
      } 
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        metadata.mediaSequence = parseInt(line.split(':')[1]);
      }
      else if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
        metadata.playlistType = line.split(':')[1];
      }
      else if (line.startsWith('#EXT-X-KEY')) {
        metadata.encryption = this.parseAttributes(line);
      }
      else if (line.startsWith('#EXT-X-MAP')) {
        metadata.map = this.parseAttributes(line);
        if (metadata.map.URI) {
          metadata.map.URI = this.resolveUrl(metadata.map.URI);
        }
      }

      // Segment tags
      else if (line.startsWith('#EXTINF')) {
        const duration = parseFloat(line.split(':')[1].split(',')[0]);
        const title = line.split(',')[1] || '';
        currentSegment = {
          duration,
          title,
          url: null,
          discontinuity
        };
        discontinuity = false;
      }
      else if (line === '#EXT-X-DISCONTINUITY') {
        discontinuity = true;
      }
      else if (line === '#EXT-X-ENDLIST') {
        metadata.endList = true;
      }

      // URL line
      else if (currentSegment && !line.startsWith('#')) {
        currentSegment.url = this.resolveUrl(line);
        segments.push(currentSegment);
        currentSegment = null;
      }
    }

    return {
      type: 'media',
      metadata,
      segments: segments.map(s => ({
        url: s.url,
        duration: s.duration,
        title: s.title,
        discontinuity: s.discontinuity
      })),
      totalDuration: segments.reduce((sum, s) => sum + s.duration, 0)
    };
  }

  /**
   * Parse attribute list from HLS tags
   * e.g., #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480
   */
  parseAttributes(tagLine) {
    const attrs = {};
    const attrString = tagLine.split(':')[1] || '';
    
    // Match key=value pairs, handling quoted values
    const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
    let match;
    
    while ((match = regex.exec(attrString)) !== null) {
      const key = match[1];
      const value = match[3] !== undefined ? match[3] : match[4];
      attrs[key] = value;
    }
    
    return attrs;
  }

  /**
   * Resolve relative URLs against base URL
   */
  resolveUrl(url) {
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    
    const base = new URL(this.baseUrl);
    
    if (url.startsWith('/')) {
      return base.origin + url;
    }
    
    // Relative path
    const pathParts = base.pathname.split('/');
    pathParts.pop(); // Remove filename
    return base.origin + pathParts.join('/') + '/' + url;
  }

  /**
   * Fetch and parse an M3U8 from URL
   */
  async fetchAndParse(url) {
    const response = await fetch(url);
    const text = await response.text();
    return this.parse(text, url);
  }

  /**
   * Get all segment URLs from a playlist (recursively resolves master playlists)
   */
  async getAllSegmentUrls(playlistUrl) {
    const playlist = await this.fetchAndParse(playlistUrl);
    
    if (playlist.type === 'master') {
      // Pick highest quality variant
      if (playlist.variants.length === 0) {
        throw new Error('No variants found in master playlist');
      }
      const bestVariant = playlist.variants[0];
      return this.getAllSegmentUrls(bestVariant.url);
    }
    
    return {
      segments: playlist.segments.map(s => s.url),
      metadata: playlist.metadata,
      totalDuration: playlist.totalDuration
    };
  }
}

// Export for use in modules or global scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HLSParser;
} else {
  window.HLSParser = HLSParser;
}