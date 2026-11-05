// Add this to the portal's pages. Talks to the Social Connect browser extension.
//
//   const social = new SocialConnectClient('<extension id>');
//   await social.isInstalled();
//   const { whatsapp, linkedin } = await social.status(); // { state: 'connected' | 'disconnected' | 'pending' }
//   await social.connect('whatsapp');
//   await social.send({ service: 'whatsapp', number: '919876543210', message: 'Hi' });
//   await social.send({ service: 'linkedin', url: 'https://www.linkedin.com/in/x', message: 'Hi' });
//
// Failed calls throw an Error with `status` and `message`. Never retry a 500 or 502
// automatically: the message may already have been sent.
class SocialConnectClient {
  constructor(extensionId) {
    this.extensionId = extensionId;
  }

  request(body) {
    return new Promise((resolve, reject) => {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        return reject(Object.assign(new Error('Extension not available in this browser'), { status: 503 }));
      }
      chrome.runtime.sendMessage(this.extensionId, body, (response) => {
        if (chrome.runtime.lastError || !response) {
          return reject(Object.assign(new Error('Extension not installed or not reachable'), { status: 503 }));
        }
        if (response.ok === false) {
          return reject(Object.assign(new Error(response.error), { status: response.status }));
        }
        resolve(response);
      });
    });
  }

  isInstalled() {
    return this.request({ type: 'ping' }).then(() => true, () => false);
  }

  status() {
    return this.request({ type: 'status' });
  }

  connect(service) {
    return this.request({ type: 'connect', service });
  }

  send(params) {
    return this.request({ type: 'send', ...params });
  }
}

if (typeof window !== 'undefined') window.SocialConnectClient = SocialConnectClient;
