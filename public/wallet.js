const wallets = new Set();
const registry = Object.freeze({
  register(...items) {
    items.forEach(w => wallets.add(w));
    return () => items.forEach(w => wallets.delete(w));
  }
});
window.addEventListener('wallet-standard:register-wallet', e => e.detail(registry));
window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {detail:registry}));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let active = false;
function make(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

export function renderWallet({el, invoice, mode, api, refresh}) {
  if (!el) return;
  el.replaceChildren();
  if (mode !== 'partner' || !invoice?.quote || invoice.status==='paid') return;
  const network = invoice.quote.network;
  const chain = network === 'mainnet' ? 'solana:mainnet' : 'solana:devnet';
  const path = '/api/invoices/'+invoice.id+'/';
  const status = make('p', invoice.providerStatus ? 'MultiHopper status · '+invoice.providerStatus : '');
  status.setAttribute('role','status');
  const showError = error => { status.textContent = error.message || 'Wallet action failed.'; };
  if (invoice.transferId) {
    const sync = make('button','Check settlement');
    sync.type='button';
    sync.onclick=async () => {
      sync.disabled=true;
      try {await api(path+'sync',{}); await refresh();}
      catch(err) {showError(err);}
      finally {sync.disabled=false;}
    };
    el.append(sync);
  }
  if (invoice.submitted) {el.append(status);return;}
  const select = make('select','');
  select.setAttribute('aria-label','Signing wallet');
  const choices = Array.from(wallets).filter(w => w.features['standard:connect'] && w.features['solana:signTransaction'] && w.chains.includes(chain));
  for (const [i,w] of choices.entries()) select.add(new Option(w.name,String(i)));
  if (!choices.length) {
    el.append(make('p','Open this desk in a browser with a Solana wallet that supports '+network+', then reload.'), status); return;
  }
  const button = make('button',invoice.transferId ? 'Review and sign route' : 'Connect wallet and lock quote');
  button.type='button';button.disabled=active;
  button.onclick=async () => {
    if (active) return;
    active=true; button.disabled=true;
    try {
      const wallet = choices[Number(select.value)];
      const {accounts} = await wallet.features['standard:connect'].connect();
      const account = accounts.find(a=>a.chains.includes(chain) && (!invoice.sourceOwner || a.address===invoice.sourceOwner));
      if (!account) throw new Error('Select the original payer on '+network+' in your wallet.');
      const owner=account.address;
      if (!invoice.transferId) {
        await api(path+'start',{owner});
      } else {
        const message = ['Approve this '+network+' USDC route?',invoice.vendor+' · '+invoice.reference,
          'Gross: '+invoice.quote.amount+' USDC','Vendor receives: '+invoice.quote.net+' USDC',
          'Estimated SOL required up front: '+invoice.quote.solLamports+' lamports',
          'From: '+owner,'To: '+invoice.recipient,'Review each transaction in your wallet.'].join('\n');
        if (!window.confirm(message)) return;
        let signed;
        for (let i=0; i<240; i++) {
          if (!el.isConnected) throw new Error('View changed. Resume from the original invoice.');
          const result=await api(path+'advance',{owner,signed});
          signed=undefined;
          if (result.stage==='submitted') break;
          if (result.stage==='sign') {
            status.textContent='Review '+result.group.replace(/Signatures?$/,'')+' in your wallet.';
            const [tx]=await wallet.features['solana:signTransaction'].signTransaction({
              account,chain,transaction:Uint8Array.from(atob(result.unsigned), c=>c.charCodeAt(0))
            });
            signed=btoa(String.fromCharCode(...tx.signedTransaction));
          } else if (result.stage==='confirming') {
            status.textContent='Waiting for Solana confirmation…';
            await wait(2200);
          }
        }
        await api(path+'sync',{});
      }
      active=false; await refresh();
    } catch(err) {showError(err);}
    finally {button.disabled=false;active=false;}
  };
  el.append(select, button, status);
}
