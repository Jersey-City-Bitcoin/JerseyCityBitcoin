---
layout: 'default.html'
description: 'About Jersey City Bitcoin'
metaTitle: 'About Jersey City Bitcoin'
title: About
permalink: 'about/'
eleventyNavigation:
    key: About
    order: 200
---
<div class="Page Page--reading">
  <header class="Page-header">
    <h1 class="Page-title">About Jersey City Bitcoin</h1>
    <p class="Page-intro">
      Jersey City Bitcoin is a decentralized community for those interested in meeting up to discuss, and learn more about bitcoin in the Jersey City, New Jersey / New York area. You can be well versed or new, all are welcome. You can contact us <a href="/contact-us/">here</a>.
    </p>
  </header>

  <section class="Page-section" aria-labelledby="follow-us">
    <h2 class="Page-section-title" id="follow-us">Follow us</h2>
    <div class="About-links">
      <a class="About-link" href="https://twitter.com/JerseyCityBTC" target="_blank" rel="noopener">
        <span class="About-link-label">Twitter</span>
        <span class="About-link-action">Open profile &rarr;</span>
      </a>
      <div class="Nostr-profile">
        <div class="Nostr-profile-header">
          <span class="About-link-label">Nostr</span>
          <a class="About-link-action" href="https://primal.net/p/nprofile1qqswaz27fwj986hnp2sjygghh2pjcthzsxw8en8tu2xlu5kksa7g0ssf5v4ja" target="_blank" rel="noopener">View on Primal &rarr;</a>
        </div>
        <label class="Nostr-label" for="nostr-npub">Nostr NPUB</label>
        <div class="Nostr-copy">
          <input id="nostr-npub" type="text" value="npub1a6y4ujay2040xz4pygs30w5r9shw9qvu0nxwhc5dlefddpmuslpqdlu2s2" readonly spellcheck="false" aria-describedby="nostr-copy-status">
          <button class="Nostr-copy-button" type="button" data-copy-npub>Copy NPUB</button>
        </div>
        <p class="Nostr-copy-status" id="nostr-copy-status" data-copy-status aria-live="polite"></p>
      </div>
    </div>
    <p class="About-note">To join our Telegram group, please attend one of our meetups. You can find more information and RSVP on <a href="https://luma.com/user/usr-Mu6rRjVWwUw3XVK">Luma</a>.</p>
  </section>
</div>

<script>
  (function () {
    var copyButton = document.querySelector('[data-copy-npub]');
    var npubInput = document.getElementById('nostr-npub');
    var copyStatus = document.querySelector('[data-copy-status]');

    if (!copyButton || !npubInput || !copyStatus) return;

    copyButton.addEventListener('click', async function () {
      var copied = false;

      try {
        await navigator.clipboard.writeText(npubInput.value);
        copied = true;
      } catch (error) {
        npubInput.focus();
        npubInput.select();
        try {
          copied = document.execCommand('copy');
        } catch (fallbackError) {
          copied = false;
        }
      }

      if (copied) {
        copyButton.textContent = 'Copied';
        copyStatus.textContent = 'NPUB copied to clipboard.';
      } else {
        npubInput.focus();
        npubInput.select();
        copyStatus.textContent = 'Select the NPUB and copy it manually.';
      }
    });
  })();
</script>
