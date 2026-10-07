const COMPANY_LOGO_URL = "./capital nest logo.jpeg";
const LOGO_MPESA = "./mpesa-logo.svg"; 
const LOGO_BANK  = "./bank-logo.svg"; 
const LOGO_CASH  = "./cash-logo.svg"; 
const SUPABASE_URL = "https://gaywjtsvopcycsynquig.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdheXdqdHN2b3BjeWNzeW5xdWlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MjY3MjQsImV4cCI6MjEwNjUwMjcyNH0.UKO5VIvaaJSddYcZ1_QFfOJOzfMdI2tCgoUUO9HTNJ4";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let cashbookTransactions = [];
let signedInEmail = '';
let signedInUserId = '';
let openingUserId = '';
let currentProfile = null;

function showAuthMessage(message, isError = true) {
  const messageElement = document.getElementById('auth-message');
  messageElement.innerText = message;
  messageElement.classList.toggle('success-message', !isError);
}

function createProfile(user, savedProfile = {}) {
  return {
    name: savedProfile.name || user.user_metadata?.full_name || user.email,
    email: user.email || '',
    phone: savedProfile.phone || '',
    business: savedProfile.business || '',
    businessType: savedProfile.business_type || '',
    purpose: savedProfile.purpose || 'Business',
    location: savedProfile.location || '',
    notes: savedProfile.notes || ''
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

async function loadLedgerEntries(userId) {
  const pageSize = 1000;
  const entries = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabaseClient.from('ledger_entries')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    entries.push(...data);
    if (data.length < pageSize) return entries;
  }
}

async function migrateLegacyBrowserData(user, profileRow, ledgerRows) {
  if (!user.email) return;

  if (!profileRow) {
    const savedProfile = localStorage.getItem(`capital-nest.profile.${encodeURIComponent(user.email)}`);
    if (savedProfile) {
      const profile = JSON.parse(savedProfile);
      const { error } = await supabaseClient.from('profiles').upsert({
        user_id: user.id,
        name: profile.name || user.user_metadata?.full_name || user.email,
        phone: profile.phone || '',
        business: profile.business || '',
        business_type: profile.businessType || '',
        purpose: profile.purpose || 'Business',
        location: profile.location || '',
        notes: profile.notes || ''
      }, { onConflict: 'user_id' });
      if (error) throw error;
    }
  }

  if (ledgerRows.length === 0) {
    const savedLedger = localStorage.getItem(`capital-nest.ledger.${encodeURIComponent(user.email)}`);
    if (savedLedger) {
      const entries = JSON.parse(savedLedger);
      if (!Array.isArray(entries)) throw new Error('Your saved browser cashbook could not be imported because its data is invalid.');
      const importedEntries = entries.map(entry => {
        const amount = Number(entry.amount);
        const timestamp = new Date(entry.timestamp);
        if (!entry.description || !Number.isFinite(amount) || amount <= 0 ||
            !['mpesa', 'bank', 'cash'].includes(entry.channel) ||
            !['income', 'expense'].includes(entry.type) ||
            !Number.isFinite(timestamp.getTime())) {
          throw new Error('Your saved browser cashbook contains an invalid transaction and could not be imported.');
        }
        return {
          user_id: user.id,
          timestamp: timestamp.toISOString(),
          description: String(entry.description),
          amount,
          channel: entry.channel,
          type: entry.type
        };
      });
      if (importedEntries.length > 0) {
        const { error } = await supabaseClient.from('ledger_entries').insert(importedEntries);
        if (error) throw error;
      }
    }
  }
}

async function openDashboard(user) {
  const [{ data: profileRow, error: profileError }, initialLedgerRows] = await Promise.all([
    supabaseClient.from('profiles').select('*').eq('user_id', user.id).maybeSingle(),
    loadLedgerEntries(user.id)
  ]);
  if (profileError) throw profileError;
  await migrateLegacyBrowserData(user, profileRow, initialLedgerRows);
  const ledgerRows = await loadLedgerEntries(user.id);
  const { data: finalProfileRow, error: finalProfileError } = profileRow
    ? { data: profileRow, error: null }
    : await supabaseClient.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
  if (finalProfileError) throw finalProfileError;

  signedInUserId = user.id;
  signedInEmail = user.email || '';
  currentProfile = createProfile(user, finalProfileRow || {});
  cashbookTransactions = (ledgerRows || []).map(transaction => ({
    ...transaction,
    amount: Number(transaction.amount),
    timestamp: new Date(transaction.timestamp)
  }));
  const profile = currentProfile;
  document.getElementById('user-display-name').innerText = `Cashbook Owner: ${profile.name}`;
  document.getElementById('cashbook-title').innerText = profile.business
    ? `${profile.business} Cashbook`
    : 'Capital Nest Cashbook';
  document.getElementById('cashbook-business-name').innerText = profile.businessType
    ? `${profile.businessType} · ${profile.purpose}`
    : profile.purpose;
  document.getElementById('profile-name').value = profile.name;
  document.getElementById('profile-email').value = profile.email;
  document.getElementById('profile-phone').value = profile.phone;
  document.getElementById('profile-business').value = profile.business;
  document.getElementById('profile-business-type').value = profile.businessType;
  document.getElementById('profile-purpose').value = profile.purpose;
  document.getElementById('profile-location').value = profile.location;
  document.getElementById('profile-notes').value = profile.notes;
  document.getElementById('profile-message').innerText = '';
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('dashboard-screen').classList.remove('hidden');
  document.getElementById('ledger-message').innerText = '';
  recompileCashbookLedger();
  startLiveSystemClock();
}

async function handleAuthSession(session) {
  const user = session?.user;
  if (!user) {
    openingUserId = '';
    signedInEmail = '';
    signedInUserId = '';
    currentProfile = null;
    cashbookTransactions = [];
    document.getElementById('dashboard-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    return;
  }
  if (signedInUserId === user.id || openingUserId === user.id) return;
  openingUserId = user.id;
  try {
    await openDashboard(user);
    showAuthMessage('');
  } catch (error) {
    showAuthMessage(error.message || 'Unable to load your cashbook. Please try again.');
  } finally {
    openingUserId = '';
  }
}

function getChannelLogo(channel) {
  if (channel === 'mpesa') return LOGO_MPESA;
  if (channel === 'bank') return LOGO_BANK;
  return LOGO_CASH;
}

function initBrandAssets() {
  if (COMPANY_LOGO_URL && COMPANY_LOGO_URL.trim() !== "") {
    const loginLogo = document.getElementById('login-logo');
    const dashLogo = document.getElementById('dashboard-logo');
    if (loginLogo) loginLogo.src = COMPANY_LOGO_URL;
    if (dashLogo) dashLogo.src = COMPANY_LOGO_URL;
  }
}

function startLiveSystemClock() {
  const clockElement = document.getElementById('live-clock-time');
  if (!clockElement) return;
  function updateClock() {
    clockElement.innerText = new Date().toLocaleTimeString('en-KE', { 
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
    });
  }
  updateClock();
  setInterval(updateClock, 1000);
}

function recompileCashbookLedger() {
  const tableBody = document.getElementById('ledger-table-body');
  if (!tableBody) return;
  
  tableBody.innerHTML = '';
  let accumulatedDebit = 0;
  let accumulatedCredit = 0;
  let runningBalance = 0;

  const chronologicalArray = [...cashbookTransactions].reverse();

  chronologicalArray.forEach(item => {
    const row = document.createElement('tr');
    const logoSrc = getChannelLogo(item.channel);
    const dateFormatted = item.timestamp.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

    let debitCell = '<span class="text-slate-muted">-</span>';
    let creditCell = '<span class="text-slate-muted">-</span>';

    if (item.type === 'income') {
      accumulatedDebit += item.amount;
      runningBalance += item.amount;
      debitCell = `<span class="text-income font-bold">+ KES ${item.amount.toLocaleString('en-KE')}</span>`;
    } else {
      accumulatedCredit += item.amount;
      runningBalance -= item.amount;
      creditCell = `<span class="text-expense font-bold">- KES ${item.amount.toLocaleString('en-KE')}</span>`;
    }

    row.innerHTML = `
      <td class="font-mono">${dateFormatted}</td>
      <td class="font-medium text-dark">${escapeHtml(item.description)}</td>
      <td>
        <div class="channel-cell">
          <img src="${logoSrc}" class="channel-icon" alt="${item.channel}">
          <span class="channel-text">${item.channel}</span>
        </div>
      </td>
      <td class="text-right">${debitCell}</td>
      <td class="text-right">${creditCell}</td>
      <td class="text-right font-bold text-dark">KES ${runningBalance.toLocaleString('en-KE')}</td>
    `;
    tableBody.insertBefore(row, tableBody.firstChild);
  });

  document.getElementById('total-received').innerText = `KES ${accumulatedDebit.toLocaleString('en-KE')}`;
  document.getElementById('total-spent').innerText = `KES ${accumulatedCredit.toLocaleString('en-KE')}`;
  
  const netBalanceContainer = document.getElementById('net-balance');
  const netValue = accumulatedDebit - accumulatedCredit;
  netBalanceContainer.innerText = `KES ${netValue.toLocaleString('en-KE')}`;
  netBalanceContainer.className = netValue >= 0 ? "text-income" : "text-expense";
}

document.getElementById('show-register').addEventListener('click', () => {
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('register-form').classList.remove('hidden');
  document.getElementById('auth-description').innerText = 'Create an account to start a new cashbook';
  showAuthMessage('');
});

document.getElementById('show-login').addEventListener('click', () => {
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('auth-description').innerText = 'Log in to access your cashbook';
  showAuthMessage('');
});

document.getElementById('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('register-name').value.trim();
  const email = document.getElementById('register-email').value.trim().toLowerCase();
  const password = document.getElementById('register-password').value;

  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { full_name: name } }
    });
    if (error) throw error;
    document.getElementById('register-form').reset();
    if (data.session) {
      showAuthMessage('Account created successfully.', false);
    } else {
      document.getElementById('register-form').classList.add('hidden');
      document.getElementById('login-form').classList.remove('hidden');
      document.getElementById('auth-description').innerText = 'Confirm your email, then log in';
      document.getElementById('login-email').value = email;
      showAuthMessage('Account created. Check your email to confirm your account before logging in.', false);
    }
  } catch (error) {
    showAuthMessage(error.message || 'Unable to create your account. Please try again.');
  }
});

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    document.getElementById('login-password').value = '';
  } catch (error) {
    showAuthMessage(error.message || 'Unable to log in. Please try again.');
  }
});

document.getElementById('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const description = document.getElementById('entry-desc').value.trim();
  const amount = parseFloat(document.getElementById('entry-amount').value);
  const channel = document.getElementById('entry-channel').value;
  const type = document.getElementById('entry-type').value;

  if (!description || !Number.isFinite(amount) || amount <= 0) {
    document.getElementById('ledger-message').innerText = 'Enter a description and an amount greater than zero.';
    return;
  }

  try {
    const { data, error } = await supabaseClient.from('ledger_entries').insert({
      user_id: signedInUserId,
      timestamp: new Date().toISOString(),
      description,
      amount,
      channel,
      type
    }).select().single();
    if (error) throw error;
    cashbookTransactions.unshift({
      ...data,
      amount: Number(data.amount),
      timestamp: new Date(data.timestamp)
    });
    recompileCashbookLedger();
    document.getElementById('ledger-message').innerText = '';
    document.getElementById('entry-form').reset();
  } catch (error) {
    document.getElementById('ledger-message').innerText =
      error.message || 'Unable to save this transaction. Please try again.';
  }
});

document.getElementById('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const profile = {
    name: document.getElementById('profile-name').value.trim(),
    email: signedInEmail,
    phone: document.getElementById('profile-phone').value.trim(),
    business: document.getElementById('profile-business').value.trim(),
    businessType: document.getElementById('profile-business-type').value.trim(),
    purpose: document.getElementById('profile-purpose').value,
    location: document.getElementById('profile-location').value.trim(),
    notes: document.getElementById('profile-notes').value.trim()
  };
  const message = document.getElementById('profile-message');
  message.classList.remove('success-message');
  try {
    const { error } = await supabaseClient.from('profiles').upsert({
      user_id: signedInUserId,
      name: profile.name,
      phone: profile.phone,
      business: profile.business,
      business_type: profile.businessType,
      purpose: profile.purpose,
      location: profile.location,
      notes: profile.notes
    }, { onConflict: 'user_id' });
    if (error) throw error;
    currentProfile = profile;
    document.getElementById('user-display-name').innerText = `Cashbook Owner: ${profile.name}`;
    document.getElementById('cashbook-title').innerText = profile.business
      ? `${profile.business} Cashbook`
      : 'Capital Nest Cashbook';
    document.getElementById('cashbook-business-name').innerText = profile.businessType
      ? `${profile.businessType} · ${profile.purpose}`
      : profile.purpose;
    message.innerText = 'Your information has been saved.';
    message.classList.add('success-message');
  } catch (error) {
    message.innerText = error.message || 'Unable to save your information. Please try again.';
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
  } catch (error) {
    document.getElementById('ledger-message').innerText = error.message || 'Unable to sign out. Please try again.';
    return;
  }
  document.getElementById('login-form').reset();
  document.getElementById('profile-form').reset();
});

document.getElementById('btn-export').addEventListener('click', async () => {
  const exportButton = document.getElementById('btn-export');
  const message = document.getElementById('ledger-message');
  if (typeof html2pdf !== 'function') {
    message.innerText = 'PDF export is unavailable. Check your internet connection and try again.';
    return;
  }

  const profile = currentProfile;
  let totalIn = 0;
  let totalOut = 0;
  let balance = 0;
  const printItems = [...cashbookTransactions].reverse();
  const elementTemplate = document.createElement('div');
  elementTemplate.style.padding = '35px';
  elementTemplate.style.fontFamily = 'sans-serif';
  elementTemplate.style.color = '#334155';

  const rowsHtml = printItems.map((t) => {
    if (t.type === 'income') {
      totalIn += t.amount;
      balance += t.amount;
    } else {
      totalOut += t.amount;
      balance -= t.amount;
    }

    const timestamp = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
    const dateText = timestamp.toLocaleDateString('en-KE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
    const timeText = timestamp.toLocaleTimeString('en-KE', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    return `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px; color: #64748b; font-family: monospace;">${dateText} ${timeText}</td>
        <td style="padding: 10px; font-weight: 500; color: #1e293b;">${escapeHtml(t.description)}</td>
        <td style="padding: 10px;">
          <img src="${getChannelLogo(t.channel)}" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 4px;">
          <span style="text-transform: uppercase; font-size: 9px; color: #64748b; font-weight: bold; vertical-align: middle;">${escapeHtml(t.channel)}</span>
        </td>
        <td style="padding: 10px; text-align: right; font-weight: 600; color: #16a34a;">${t.type === 'income' ? `KES ${t.amount.toLocaleString('en-KE')}` : '-'}</td>
        <td style="padding: 10px; text-align: right; font-weight: 600; color: #dc2626;">${t.type === 'expense' ? `KES ${t.amount.toLocaleString('en-KE')}` : '-'}</td>
        <td style="padding: 10px; text-align: right; font-weight: 700; color: #0f172a;">KES ${balance.toLocaleString('en-KE')}</td>
      </tr>
    `;
  }).join('');

  elementTemplate.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #4f46e5; padding-bottom: 15px; margin-bottom: 25px;">
      <div>
        <h1 style="font-size: 22px; font-weight: bold; margin: 0; color: #0f172a;">${escapeHtml(profile.business || 'Capital Nest')} Cashbook Statement</h1>
        <p style="font-size: 11px; color: #64748b; margin: 4px 0 0 0;">Capital Nest · ${escapeHtml(profile.name)}</p>
      </div>
      ${COMPANY_LOGO_URL ? `<img src="${COMPANY_LOGO_URL}" alt="Capital Nest" style="max-height: 45px; width: auto; object-fit: contain; border-radius: 4px;">` : ''}
    </div>
    <div style="margin: 0 0 20px; padding: 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 11px; color: #334155;">
      ${[
        ['Email', profile.email],
        ['Phone', profile.phone],
        ['Business or group', profile.business],
        ['Business type', profile.businessType],
        ['Records for', profile.purpose],
        ['Town or location', profile.location],
        ['Other information', profile.notes]
      ].filter(([, value]) => value).map(([label, value]) =>
        `<div style="margin: 3px 0;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`
      ).join('')}
    </div>
    <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 20px;">
      <thead>
        <tr style="background: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
          <th style="padding: 10px;">Timestamp</th>
          <th style="padding: 10px;">Particulars</th>
          <th style="padding: 10px;">Mode</th>
          <th style="padding: 10px; text-align: right;">Debit (Dr)</th>
          <th style="padding: 10px; text-align: right;">Credit (Cr)</th>
          <th style="padding: 10px; text-align: right;">Balance</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
    <div style="margin-top: 30px; display: flex; justify-content: flex-end; gap: 20px; font-size: 12px; font-weight: bold; border-top: 2px dashed #cbd5e1; padding-top: 15px;">
      <div style="color: #16a34a;">Total Dr: KES ${totalIn.toLocaleString('en-KE')}</div>
      <div style="color: #dc2626;">Total Cr: KES ${totalOut.toLocaleString('en-KE')}</div>
      <div style="color: #4f46e5; background: #f5f3ff; padding: 4px 10px; border-radius: 4px;">Closing Capital: KES ${(totalIn - totalOut).toLocaleString('en-KE')}</div>
    </div>
  `;

  const safeBusinessName = (profile.business || 'capital-nest')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'capital-nest';
  exportButton.disabled = true;
  message.innerText = 'Preparing your PDF download...';
  try {
    await html2pdf().from(elementTemplate).set({
      margin: 10,
      filename: `${safeBusinessName}-cashbook-statement.pdf`,
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { format: 'a4', orientation: 'portrait' }
    }).save();
    message.innerText = 'Your PDF has been downloaded.';
  } catch (error) {
    message.innerText = error.message || 'Unable to generate the PDF. Please try again.';
  } finally {
    exportButton.disabled = false;
  }
});

window.addEventListener('DOMContentLoaded', () => {
  initBrandAssets();
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => handleAuthSession(session), 0);
  });
});
