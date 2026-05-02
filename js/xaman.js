/**
 * XRP Music - Xaman Wallet Integration
 * Handles wallet connection, authentication, and signing
 * 
 * IMPORTANT: Sessions are NOT persisted across page closes.
 * Users must re-authenticate with Xaman each time they visit.
 * This prevents stale session issues and ensures fresh wallet connections.
 * 
 * MINTING: Uses Railway worker queue - no timeout limits!
 * Max 10,000 NFTs per batch. User can close page after signing.
 * 
 * XAMAN 5.0 WORKAROUND: Added Memos + extra custom_meta fields to
 * NFTokenAcceptOffer payloads to prevent "Text Strings must be rendered
 * within a <Text> component" crash in Xaman 5.0's NFT offer detail screen.
 * 
 * FEB 2026: Swapped xrplcluster.com → s1.ripple.com for tx lookups
 * due to xrplcluster.com timeouts causing purchase failures.
 * 
 * APR 2026 AUTH/PAYMENT FIX V3:
 * - AUTH (wallet connect): Same-tab redirect for ALL devices (no popups, no new tabs)
 * - TRANSACTIONS (payments/minting): Popup window (stay on page)
 * - Mobile deep links to Xaman app, returns to same tab
 * - Clean UX: no blank tabs, no confusion
 */

const XAMAN_API_KEY = 'f5073b74-f988-4496-8e0e-67133fa18393';

// Session key for this browser tab only
const SESSION_KEY = 'xrpmusic_session';

// Key for saving pre-auth context (what the user was doing before signing in)
const AUTH_CONTEXT_KEY = 'xrpmusic_auth_context';

// XRPL node for client-side tx lookups (offer index extraction)
const XRPL_LOOKUP_NODE = 'https://xrplcluster.com';

const XamanWallet = {
  sdk: null,
  initialized: false,
  isConnecting: false,
  mintProgressInterval: null,
  
  /**
   * Open Xaman URL - smart detection of auth vs transaction
   * @param {string} url - Xaman sign URL
   */
  openXamanPopup(url) {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // Detect if this is an AUTH request (wallet connect) vs TRANSACTION (payment/mint/etc)
    const isAuthRequest = this.isConnecting === true;
    
    if (isAuthRequest) {
      // ===== AUTH FLOW (Connect Wallet) =====
      console.log('🔐 Opening Xaman for AUTH');
      
      // BOTH mobile and desktop: redirect same tab
      // Mobile will deep link to Xaman app, user returns to same tab
      window.location.href = url;
      return null;
      
    } else {
      // ===== TRANSACTION FLOW (Payments, Minting, NFT operations) =====
      console.log('💳 Opening Xaman for TRANSACTION');
      
      const width = 420;
      const height = 700;
      const left = (window.screen.width - width) / 2;
      const top = (window.screen.height - height) / 2;
      
      const popup = window.open(
        url,
        'XamanSign',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
      );
      
      if (popup) popup.focus();
      
      return popup;
    }
  },
  
  /**
   * Save the current page context before triggering auth
   * so we can restore it after login completes.
   */
  saveAuthContext(context = {}) {
    const ctx = {
      page: Router?.params?.page || null,
      releaseId: context.releaseId || null,
      action: context.action || null,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(AUTH_CONTEXT_KEY, JSON.stringify(ctx));
    console.log('Auth context saved:', ctx);
  },

  /**
   * Read and clear the saved auth context.
   */
  popAuthContext() {
    let raw = sessionStorage.getItem(AUTH_CONTEXT_KEY);
    if (raw) {
      sessionStorage.removeItem(AUTH_CONTEXT_KEY);
    }
    if (!raw) return null;
    
    try {
      const ctx = JSON.parse(raw);
      // Only restore if context is recent (< 10 minutes)
      if (Date.now() - ctx.timestamp > 10 * 60 * 1000) return null;
      return ctx;
    } catch {
      return null;
    }
  },

  /**
   * Restore the pre-auth context after login.
   * Re-opens the release modal the user was viewing before signing in.
   */
  async restoreAuthContext() {
    const ctx = this.popAuthContext();
    if (!ctx) return;

    console.log('Restoring auth context:', ctx);

    // If user was viewing a release, re-open it
    if (ctx.releaseId) {
      try {
        const data = await API.getRelease(ctx.releaseId);
        if (data?.release && typeof Modals !== 'undefined') {
          setTimeout(() => {
            Modals.showRelease(data.release);
          }, 400);
        }
      } catch (err) {
        console.warn('Could not restore release context:', err);
      }
    }
  },

  /**
   * Initialize Xaman SDK
   */
  async init() {
    if (this.initialized) return;
    
    try {
      if (typeof Xumm === 'undefined') {
        await this.loadSDK();
      }
      
      this.sdk = new Xumm(XAMAN_API_KEY);
      
      // Set up page unload handler to clear session
      this.setupAutoLogout();
      
      this.sdk.on('success', async () => {
        try {
          const account = await this.sdk.user.account;
          if (account) {
            // Save session
            this.saveSessionToTab(account);
            saveSession(account);
            AppState.walletType = 'xaman';
            
            await this.loadUserData(account);
            UI.updateAuthUI();
            UI.showLoggedInState();
            
            // Initialize mint notifications
            if (typeof MintNotifications !== 'undefined') {
              MintNotifications.init();
            }
            
            // Restore context after login
            console.log('✅ Logged in successfully:', account);
            await this.restoreAuthContext();
          }
        } catch (err) {
          console.error('Error getting account after success:', err);
        }
        this.isConnecting = false;
      });
      
      this.sdk.on('logout', () => {
        this.clearTabSession();
        clearSession();
        UI.updateAuthUI();
        UI.showLoggedOutState();
        
        if (typeof MintNotifications !== 'undefined') {
          MintNotifications.cleanup();
        }
      });
      
      this.sdk.on('error', (err) => {
        console.error('Xumm error:', err);
        this.isConnecting = false;
      });

      const readyTimeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('SDK ready timeout')), 10000)
      );
      
      try {
        await Promise.race([this.sdk.environment.ready, readyTimeout]);
      } catch (err) {
        console.warn('SDK ready timeout, continuing anyway');
      }
      
      this.handlePageLoad();
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize Xaman:', error);
    }
  },
  
  /**
   * Set up automatic logout on page close/unload
   */
  setupAutoLogout() {
    window.addEventListener('beforeunload', () => {
      localStorage.removeItem('xrpmusic_user');
      localStorage.removeItem('xrpmusic_profile');
    });
    
    // Handle visibility change (tab hidden for too long)
    let hiddenTime = null;
    const MAX_HIDDEN_TIME = 30 * 60 * 1000; // 30 minutes
    
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenTime = Date.now();
      } else if (hiddenTime) {
        const elapsed = Date.now() - hiddenTime;
        if (elapsed > MAX_HIDDEN_TIME && AppState.user?.address) {
          console.log('Session expired due to inactivity, logging out...');
          this.disconnect();
        }
        hiddenTime = null;
      }
    });
  },
  
  /**
   * Handle page load - restore session if same-tab
   */
 handlePageLoad() {
  const tabSession = sessionStorage.getItem(SESSION_KEY);
  
  // Check if we just came back from Xaman auth (URL has xApp query param)
  const urlParams = new URLSearchParams(window.location.search);
  const comingFromXaman = urlParams.has('xApp') || urlParams.has('payload');
  
  if (comingFromXaman) {
    // User just authenticated - force session check
    console.log('Returned from Xaman auth, checking session...');
    setTimeout(() => {
      this.checkSession().then(() => {
        if (AppState.user?.address) {
          this.restoreAuthContext();
          // Clean up URL
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }).catch(err => {
        console.warn('Session check failed:', err);
      });
    }, 1000);
    return;
  }
  
  if (!tabSession) {
    // Fresh page load - clear stale sessions
    console.log('Fresh page load - clearing stale sessions');
    localStorage.removeItem('xrpmusic_user');
    localStorage.removeItem('xrpmusic_profile');
    if (typeof clearSession === 'function') {
      clearSession();
    }
    if (typeof UI !== 'undefined' && UI.updateAuthUI) {
      UI.updateAuthUI();
      UI.showLoggedOutState();
    }
  } else {
    // Same tab navigation - restore session
    console.log('Same-tab session found, restoring...');
    this.checkSession().then(() => {
      if (AppState.user?.address) {
        this.restoreAuthContext();
      }
    }).catch(err => {
      console.warn('Session check failed:', err);
    });
  }
},
  
  /**
   * Save session marker to sessionStorage (tab-specific)
   */
  saveSessionToTab(address) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      address: address,
      timestamp: Date.now()
    }));
  },
  
  /**
   * Clear tab session
   */
  clearTabSession() {
    sessionStorage.removeItem(SESSION_KEY);
  },
  
  /**
   * Load Xumm SDK from CDN with timeout
   */
  loadSDK() {
    return new Promise((resolve, reject) => {
      if (typeof Xumm !== 'undefined') {
        resolve();
        return;
      }
      
      const timeout = setTimeout(() => {
        reject(new Error('Xumm SDK load timeout'));
      }, 10000);
      
      const script = document.createElement('script');
      script.src = 'https://xumm.app/assets/cdn/xumm.min.js';
      script.async = true;
      script.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Failed to load Xumm SDK'));
      };
      document.head.appendChild(script);
    });
  },
  
  /**
   * Check for existing session
   */
  async checkSession() {
    const tabSession = sessionStorage.getItem(SESSION_KEY);
    if (!tabSession) {
      console.log('No tab session, skipping session check');
      return;
    }
    
    if (AppState.user?.address) {
      await this.loadUserData(AppState.user.address);
      UI.updateAuthUI();
      if (typeof MintNotifications !== 'undefined') {
        MintNotifications.init();
      }
      return;
    }
    
    try {
      const account = await this.sdk.user.account;
      if (account) {
        this.saveSessionToTab(account);
        saveSession(account);
        await this.loadUserData(account);
        UI.updateAuthUI();
        if (typeof MintNotifications !== 'undefined') {
          MintNotifications.init();
        }
      }
    } catch (err) {
      console.log('No existing SDK session');
      this.clearTabSession();
    }
  },
  
  /**
   * Load user data (profile, liked tracks, playlists)
   */
  async loadUserData(address) {
    try {
      const profile = await API.getProfile(address);
      if (profile) {
        setProfile(profile);
      }
      
      const likedIds = await API.getLikedTrackIds(address);
      AppState.likedTrackIds = new Set(likedIds);
      
      const playlists = await API.getPlaylists(address);
      setPlaylists(playlists);

      scanExternalMusicNfts(address);

      if (typeof OwnershipHelper !== 'undefined') {
        OwnershipHelper.init();
      }
      
    } catch (error) {
      console.error('Failed to load user data:', error);
    }
  },
  
  /**
   * Connect wallet
   */
 async connect() {
  if (!this.sdk || this.isConnecting) return;
  
  this.isConnecting = true;
  
  try {
    sessionStorage.setItem('xrpmusic_return_url', window.location.href);
    
    // Tell Xaman to redirect back to the current page after auth
    const returnUrl = window.location.href.split('?')[0]; // Remove any existing query params
    
    await this.sdk.authorize({
      options: {
        return_url: {
          web: returnUrl
        }
      }
    });
  } catch (err) {
    console.error('Failed to connect wallet:', err);
    this.isConnecting = false;
  }
},
  
  /**
   * Disconnect wallet
   */
  disconnect() {
    AppState.walletType = null;
    if (this.sdk) {
      this.sdk.logout();
    }
    this.clearTabSession();
    clearSession();
    UI.updateAuthUI();
    UI.showLoggedOutState();
    
    if (typeof MintNotifications !== 'undefined') {
      MintNotifications.cleanup();
    }
  },
  
  /**
   * Check if connected
   */
  isConnected() {
    return !!AppState.user?.address;
  },
  
  /**
   * Get current address
   */
  getAddress() {
    return AppState.user?.address || null;
  },
  
  /**
   * Stop any active polling
   */
  stopMintProgress() {
    if (this.mintProgressInterval) {
      clearInterval(this.mintProgressInterval);
      this.mintProgressInterval = null;
    }
  },
  
  /**
   * Helper: Convert string to hex (used for Memos)
   */
  stringToHex(str) {
    let hex = '';
    for (let i = 0; i < str.length; i++) {
      hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex.toUpperCase();
  },
  
  /**
   * Convert XRP to drops
   */
  xrpToDrops(xrp) {
    return Math.floor(xrp * 1_000_000).toString();
  },
  
  /**
   * Convert drops to XRP
   */
  dropsToXrp(drops) {
    return Number(drops) / 1_000_000;
  },
  
  /**
   * Build a Memo array for transactions.
   * Xaman 5.0 workaround: explicit memos prevent null-string render crash.
   */
  buildMemo(text) {
    return [{
      Memo: {
        MemoType: this.stringToHex('text/plain'),
        MemoData: this.stringToHex(text || 'XRP Music'),
      }
    }];
  },
  
  /**
   * Mint NFT - Fire and Forget!
   */
  async mintNFT(metadataUri, options = {}) {
    if (!this.sdk) {
      console.error('mintNFT: SDK not initialized');
      throw new Error('SDK not initialized');
    }
    
    if (!AppState.user?.address) {
      throw new Error('Wallet not connected');
    }
    
    const { 
      quantity = 1, 
      transferFee = 500, 
      taxon = 0, 
      onProgress, 
      tracks = null, 
      trackIds = null,
      releaseId = null
    } = options;
    
    if (quantity > 10000) {
      throw new Error('Maximum 10,000 NFTs per batch');
    }
    
    const trackCount = tracks ? tracks.length : 1;
    const totalNFTs = trackCount * quantity;
    
    if (totalNFTs > 10000) {
      throw new Error('Maximum 10,000 NFTs per batch (tracks × editions)');
    }
    
    const mintFee = (totalNFTs * 0.000012) + 0.001;
    const mintFeeDrops = Math.ceil(mintFee * 1000000).toString();
    
    const configResponse = await fetch('/api/batch-mint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getConfig' }),
    });
    const configData = await configResponse.json();
    const platformAddress = configData.platformAddress;
    
    if (!platformAddress) {
      throw new Error('Platform not configured');
    }
    
    console.log('Starting mint process...', { platformAddress, trackCount, quantity, totalNFTs, mintFee, trackIds, releaseId });
    
    try {
      if (onProgress) {
        onProgress({
          stage: 'paying',
          message: `Step 1/2: Pay mint fee (${mintFee.toFixed(6)} XRP)`,
          quantity: quantity,
          progress: 0,
        });
      }
      
      if (!this.sdk.payload) {
        console.error('SDK payload not available, waiting...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!this.sdk.payload) {
          throw new Error('Xaman SDK not fully loaded. Please refresh and try again.');
        }
      }
      
      console.log('Creating payment payload...');
      
      let paymentPayload;
      try {
        paymentPayload = await this.sdk.payload.create({
          txjson: {
            TransactionType: 'Payment',
            Destination: platformAddress,
            Amount: mintFeeDrops,
            Memos: this.buildMemo(`Mint fee for ${totalNFTs} NFT editions`),
          },
          custom_meta: {
            instruction: `Pay ${mintFee.toFixed(6)} XRP mint fee for ${totalNFTs} NFT editions`,
          },
        });
      } catch (payloadError) {
        console.error('Failed to create payment payload:', payloadError);
        throw new Error('Session expired - please refresh the page and reconnect your wallet');
      }
      
      if (!paymentPayload || !paymentPayload.uuid) {
        throw new Error('Failed to create Xaman request - please refresh and reconnect your wallet');
      }
      
      if (paymentPayload.next?.always) {
        console.log('Opening Xaman for fee payment:', paymentPayload.next.always);
        this.openXamanPopup(paymentPayload.next.always);
      } else {
        throw new Error('No sign URL returned from Xaman');
      }
      
      const paymentResult = await this.waitForPayload(paymentPayload.uuid);
      
      if (!paymentResult.success) {
        throw new Error('Mint fee payment cancelled');
      }
      
      console.log('Mint fee paid:', paymentResult.txHash);
      
      if (onProgress) {
        onProgress({
          stage: 'authorizing',
          message: 'Step 2/2: Authorize minting in Xaman',
          quantity: quantity,
          progress: 25,
        });
      }
      
      console.log('Creating authorization payload...');
      
      let authPayload;
      try {
        authPayload = await this.sdk.payload.create({
          txjson: {
            TransactionType: 'AccountSet',
            NFTokenMinter: platformAddress,
            SetFlag: 10,
          },
          custom_meta: {
            instruction: `Authorize XRP Music to mint ${totalNFTs} NFT editions for you`,
          },
        });
      } catch (authError) {
        console.error('Failed to create auth payload:', authError);
        throw new Error('Session expired - please refresh the page and reconnect your wallet');
      }
      
      if (!authPayload || !authPayload.uuid) {
        throw new Error('Failed to create Xaman request - please refresh and reconnect your wallet');
      }
      
      if (authPayload.next?.always) {
        console.log('Opening Xaman for authorization:', authPayload.next.always);
        this.openXamanPopup(authPayload.next.always);
      } else {
        throw new Error('No sign URL returned from Xaman');
      }
      
      const authResult = await this.waitForPayload(authPayload.uuid);
      
      if (!authResult.success) {
        throw new Error('Authorization cancelled');
      }
      
      console.log('Authorization successful:', authResult.txHash);
      
      if (onProgress) {
        onProgress({
          stage: 'queuing',
          message: `Queuing ${totalNFTs} NFTs for minting...`,
          quantity: totalNFTs,
          progress: 50,
        });
      }
      
      console.log('Queuing mint job...');
      
      const queueResponse = await fetch('/api/queue-mint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artistAddress: AppState.user.address,
          releaseId: releaseId,
          quantity: quantity,
          transferFee: transferFee,
        }),
      });
      
      const queueData = await queueResponse.json();
      
      if (!queueData.success) {
        throw new Error(queueData.error || 'Failed to queue mint job');
      }
      
      console.log('Mint job queued successfully:', queueData);
      
      const jobId = queueData.jobId;
      
      if (typeof MintNotifications !== 'undefined') {
        MintNotifications.addJob(jobId, releaseId, totalNFTs);
      }
      
      if (onProgress) {
        onProgress({
          stage: 'queued',
          message: `✓ Minting queued! You can close this page.`,
          subMessage: `Check the 🔔 notification bell for progress.`,
          quantity: totalNFTs,
          jobId: jobId,
          canClose: true,
          progress: 100,
        });
      }
      
      return {
        success: true,
        queued: true,
        jobId: jobId,
        txHash: authResult.txHash,
        paymentTxHash: paymentResult.txHash,
        totalNFTs: totalNFTs,
        message: 'Mint job queued. Check notifications for progress.',
      };
      
    } catch (error) {
      this.stopMintProgress();
      console.error('mintNFT error:', error);
      throw error;
    }
  },
  
  /**
   * Wait for payload to be signed
   */
  waitForPayload(uuid) {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 120;
      
      const checkStatus = async () => {
        attempts++;
        
        try {
          const status = await this.sdk.payload.get(uuid);
          
          if (status?.meta?.resolved) {
            if (status.meta.signed) {
              resolve({
                success: true,
                txHash: status.response?.txid,
              });
            } else {
              resolve({
                success: false,
                error: 'Transaction rejected by user',
              });
            }
            return;
          }
          
          if (attempts >= maxAttempts) {
            resolve({
              success: false,
              error: 'Transaction timed out',
            });
            return;
          }
          
          setTimeout(checkStatus, 2000);
        } catch (err) {
          console.error('Error checking status:', err);
          if (attempts >= maxAttempts) {
            resolve({
              success: false,
              error: 'Failed to check transaction status',
            });
          } else {
            setTimeout(checkStatus, 2000);
          }
        }
      };
      
      checkStatus();
    });
  },
  
  /**
   * Send XRP payment to an address
   */
  async sendPayment(destination, amountXRP, memo = '') {
    if (!this.sdk) throw new Error('SDK not initialized');
    if (!AppState.user?.address) throw new Error('Wallet not connected');
    
    console.log(`Creating payment: ${amountXRP} XRP to ${destination}`);
    
    const txJson = {
      TransactionType: 'Payment',
      Destination: destination,
      Amount: this.xrpToDrops(amountXRP),
      Memos: this.buildMemo(memo || `XRP Music payment: ${amountXRP} XRP`),
    };
    
    let payload;
    try {
      payload = await this.sdk.payload.create({
        txjson: txJson,
        custom_meta: {
          instruction: `Pay ${amountXRP} XRP for music NFT`,
        },
      });
    } catch (payloadError) {
      console.error('Failed to create payment payload:', payloadError);
      throw new Error('Session expired - please refresh the page and reconnect your wallet');
    }
    
    if (!payload || !payload.uuid) {
      throw new Error('Failed to create payment payload - please refresh and reconnect your wallet');
    }
    
    console.log('Payment payload created:', payload.uuid);
    
    if (payload.next?.always) {
      console.log('Opening Xaman for payment:', payload.next.always);
      this.openXamanPopup(payload.next.always);
    } else {
      throw new Error('No sign URL returned from Xaman');
    }
    
    return this.waitForPayload(payload.uuid);
  },
  
  /**
   * Create NFT transfer offer (Amount: 0) to transfer NFT to platform
   */
  async createTransferOffer(nftTokenId, destination) {
    if (!this.sdk) throw new Error('SDK not initialized');
    if (!AppState.user?.address) throw new Error('Wallet not connected');
    
    console.log('Creating transfer offer:', { nftTokenId, destination });
    
    let payload;
    try {
      payload = await this.sdk.payload.create({
        txjson: {
          TransactionType: 'NFTokenCreateOffer',
          NFTokenID: nftTokenId,
          Amount: '0',
          Flags: 1,
          Destination: destination,
          Memos: this.buildMemo('XRP Music NFT listing transfer'),
        },
        custom_meta: {
          instruction: 'Sign to transfer your NFT to XRP Music for listing',
        },
      });
    } catch (payloadError) {
      console.error('Failed to create transfer payload:', payloadError);
      throw new Error('Session expired - please refresh the page and reconnect your wallet');
    }
    
    if (!payload || !payload.uuid) {
      throw new Error('Failed to create transfer payload - please refresh and reconnect your wallet');
    }
    
    if (payload.next?.always) {
      this.openXamanPopup(payload.next.always);
    } else {
      throw new Error('No sign URL returned from Xaman');
    }
    
    const result = await this.waitForPayload(payload.uuid);
    
    if (result.success && result.txHash) {
      try {
        const offerIndex = await this.getOfferIndexFromTx(result.txHash);
        if (offerIndex) {
          result.offerIndex = offerIndex;
        } else {
          const fallbackIndex = await this.getLatestSellOffer(nftTokenId, AppState.user.address);
          if (fallbackIndex) {
            result.offerIndex = fallbackIndex;
          }
        }
      } catch (err) {
        console.error('Failed to get offer index for transfer:', err);
      }
    }
    
    return result;
  },
  
  /**
   * Accept a sell offer to receive an NFT
   * 
   * XAMAN 5.0 WORKAROUND: Added explicit Memos, force_network, identifier,
   * and expanded blob fields to prevent the crash.
   */
  async acceptSellOffer(offerIndex) {
    if (!this.sdk) throw new Error('SDK not initialized');
    if (!AppState.user?.address) throw new Error('Wallet not connected');
    
    console.log('Accepting sell offer:', offerIndex);
    
    let payload;
    try {
      payload = await this.sdk.payload.create({
        txjson: {
          TransactionType: 'NFTokenAcceptOffer',
          NFTokenSellOffer: offerIndex,
          Memos: this.buildMemo('XRP Music NFT purchase'),
        },
        options: {
          force_network: 'MAINNET',
        },
        custom_meta: {
          instruction: 'Sign to receive your music NFT',
          identifier: 'xrpmusic_nft_accept',
          blob: {
            purpose: 'NFT Transfer',
            platform: 'XRP Music',
            description: 'Accept NFT sell offer',
            type: 'NFTokenAcceptOffer',
            offer: offerIndex || '',
          },
        },
      });
    } catch (payloadError) {
      console.error('Failed to create accept offer payload:', payloadError);
      throw new Error('Session expired - please refresh the page and reconnect your wallet');
    }
    
    if (!payload || !payload.uuid) {
      throw new Error('Failed to create accept offer payload - please refresh and reconnect your wallet');
    }
    
    if (payload.next?.always) {
      console.log('Opening Xaman for accept offer:', payload.next.always);
      this.openXamanPopup(payload.next.always);
    } else {
      throw new Error('No sign URL returned from Xaman');
    }
    
    return this.waitForPayload(payload.uuid);
  },
  
  /**
   * Create a sell offer for an NFT (secondary market listing)
   */
  async createSellOffer(nftTokenId, price) {
    if (!this.sdk) throw new Error('SDK not initialized');
    if (!AppState.user?.address) throw new Error('Wallet not connected');
    
    console.log('Creating sell offer for:', nftTokenId, 'at', price, 'XRP');
    
    const amountInDrops = Math.floor(price * 1000000).toString();
    
    let payload;
    try {
      payload = await this.sdk.payload.create({
        txjson: {
          TransactionType: 'NFTokenCreateOffer',
          NFTokenID: nftTokenId,
          Amount: amountInDrops,
          Flags: 1,
          Memos: this.buildMemo(`XRP Music listing: ${price} XRP`),
        },
        custom_meta: {
          instruction: `List your NFT for sale at ${price} XRP`,
        },
      });
    } catch (payloadError) {
      console.error('Failed to create sell offer payload:', payloadError);
      throw new Error('Session expired - please refresh the page and reconnect your wallet');
    }
    
    if (!payload || !payload.uuid) {
      throw new Error('Failed to create sell offer payload - please refresh and reconnect your wallet');
    }
    
    if (payload.next?.always) {
      this.openXamanPopup(payload.next.always);
    } else {
      throw new Error('No sign URL returned from Xaman');
    }
    
    const result = await this.waitForPayload(payload.uuid);
    
    if (result.success && result.txHash) {
      try {
        const offerIndex = await this.getOfferIndexFromTx(result.txHash);
        if (offerIndex) {
          result.offerIndex = offerIndex;
        } else {
          const fallbackIndex = await this.getLatestSellOffer(nftTokenId, AppState.user.address);
          if (fallbackIndex) {
            result.offerIndex = fallbackIndex;
          }
        }
      } catch (err) {
        console.error('Failed to get offer index:', err);
        try {
          const fallbackIndex = await this.getLatestSellOffer(nftTokenId, AppState.user.address);
          if (fallbackIndex) {
            result.offerIndex = fallbackIndex;
          }
        } catch (e) {
          console.error('Fallback also failed:', e);
        }
      }
    }
    
    return result;
  },
  
  /**
   * Cancel a sell offer on XRPL
   */
  async cancelSellOffer(offerIndex) {
    if (!this.sdk) throw new Error('SDK not initialized');
    if (!AppState.user?.address) throw new Error('Wallet not connected');
    
    console.log('Cancelling sell offer:', offerIndex);
    
    let payload;
    try {
      payload = await this.sdk.payload.create({
        txjson: {
          TransactionType: 'NFTokenCancelOffer',
          NFTokenOffers: [offerIndex],
          Memos: this.buildMemo('XRP Music cancel listing'),
        },
        custom_meta: {
          instruction: 'Cancel your NFT listing',
        },
      });
    } catch (payloadError) {
      console.error('Failed to create cancel offer payload:', payloadError);
      throw new Error('Session expired - please refresh the page and reconnect your wallet');
    }
    
    if (!payload || !payload.uuid) {
      throw new Error('Failed to create cancel offer payload - please refresh and reconnect your wallet');
    }
    
    if (payload.next?.always) {
      this.openXamanPopup(payload.next.always);
    } else {
      throw new Error('No sign URL returned from Xaman');
    }
    
    return this.waitForPayload(payload.uuid);
  },
  
  /**
   * Edit listing price (cancel old offer + create new one)
   */
  async editListingPrice(nftTokenId, oldOfferIndex, newPrice) {
    if (!this.sdk) throw new Error('SDK not initialized');
    if (!AppState.user?.address) throw new Error('Wallet not connected');
    
    console.log('Editing listing price:', { nftTokenId, oldOfferIndex, newPrice });
    
    const cancelResult = await this.cancelSellOffer(oldOfferIndex);
    
    if (!cancelResult.success) {
      throw new Error('Failed to cancel old listing: ' + (cancelResult.error || 'Unknown error'));
    }
    
    console.log('Old offer cancelled, creating new offer...');
    
    return this.createSellOffer(nftTokenId, newPrice);
  },
  
  /**
   * Get offer index from transaction metadata
   */
  async getOfferIndexFromTx(txHash) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      const response = await fetch(XRPL_LOOKUP_NODE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tx',
          params: [{ transaction: txHash, binary: false }]
        })
      });
      
      const data = await response.json();
      
      if (data.result?.meta?.AffectedNodes) {
        for (const node of data.result.meta.AffectedNodes) {
          if (node.CreatedNode?.LedgerEntryType === 'NFTokenOffer') {
            let offerIndex = node.CreatedNode.LedgerIndex;
            if (offerIndex && offerIndex.length < 64) {
              offerIndex = offerIndex.padStart(64, '0');
            }
            console.log('Found offer index from transaction:', offerIndex);
            return offerIndex;
          }
        }
      }
      
      return null;
    } catch (err) {
      console.error('getOfferIndexFromTx error:', err);
      return null;
    }
  },
  
  /**
   * Get the latest sell offer for an NFT from a specific owner
   */
  async getLatestSellOffer(nftTokenId, ownerAddress) {
    try {
      const response = await fetch(XRPL_LOOKUP_NODE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'nft_sell_offers',
          params: [{ nft_id: nftTokenId }]
        })
      });
      
      const data = await response.json();
      
      if (data.result?.offers) {
        const ownerOffers = data.result.offers.filter(o => o.owner === ownerAddress);
        if (ownerOffers.length > 0) {
          let offerIndex = ownerOffers[ownerOffers.length - 1].nft_offer_index;
          if (offerIndex && offerIndex.length < 64) {
            offerIndex = offerIndex.padStart(64, '0');
          }
          return offerIndex;
        }
      }
      return null;
    } catch (err) {
      console.error('getLatestSellOffer error:', err);
      return null;
    }
  },
};
