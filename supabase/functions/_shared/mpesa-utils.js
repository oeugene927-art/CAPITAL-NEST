export function normalizeKenyanPhone(input) {
  if (typeof input !== 'string') return '';

  const raw = input.trim().replace(/\s+/g, '').replace(/^00/, '');
  const digits = raw.replace(/\D/g, '');

  if (!digits) return '';

  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^\+?254[17]\d{8}$/.test(raw.replace(/\+/, ''))) return `254${digits.slice(3)}`;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;

  return '';
}

export function isValidKenyanPhone(input) {
  const normalized = normalizeKenyanPhone(input);
  return /^254[17]\d{8}$/.test(normalized);
}

export function isPositiveWholeKesAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && Number.isInteger(numeric);
}

export function getDarajaBaseUrl(env = 'sandbox') {
  return env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

export function createStkPushRequest({
  amount,
  phoneNumber,
  shortcode,
  shortcodeType,
  passkey,
  callbackUrl,
  accountReference,
  transactionDescription,
  partyA,
  timestamp
}) {
  const safePhone = normalizeKenyanPhone(phoneNumber);

  if (!isPositiveWholeKesAmount(amount)) {
    throw new Error('Amount must be a positive whole number of KES.');
  }

  if (!isValidKenyanPhone(safePhone)) {
    throw new Error('Phone number must be a valid Kenyan number in 2547XXXXXXXX or 2541XXXXXXXX format.');
  }

  if (!shortcode || !passkey || !callbackUrl || !transactionDescription) {
    throw new Error('Daraja STK configuration is incomplete.');
  }

  const businessShortCode = String(shortcode).trim();
  const transType = shortcodeType === 'till' ? 'CustomerPayBillOnline' : 'CustomerPayBillOnline';

  return {
    BusinessShortCode: businessShortCode,
    Password: btoa(`${businessShortCode}${passkey}${timestamp}`),
    Timestamp: timestamp,
    TransactionType: transType,
    Amount: Number(amount),
    PartyA: partyA || safePhone,
    PartyB: businessShortCode,
    PhoneNumber: Number(safePhone),
    CallBackURL: callbackUrl,
    AccountReference: accountReference || 'Capital Nest',
    TransactionDesc: transactionDescription
  };
}

export async function requestDarajaToken({ baseUrl, consumerKey, consumerSecret, fetchFn = fetch }) {
  const response = await fetchFn(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${btoa(`${consumerKey}:${consumerSecret}`)}`,
      Accept: 'application/json'
    }
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(data?.error_description || 'Unable to obtain a Daraja OAuth token.');
  }

  return data;
}

export async function requestDarajaStkPush({ baseUrl, accessToken, payload, fetchFn = fetch }) {
  const response = await fetchFn(`${baseUrl}/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  return { ok: response.ok && Number(data.ResponseCode) === 0, response: data, status: response.status };
}

export function getPendingPaymentStatus(payment, callbackPayload) {
  const callback = callbackPayload?.Body?.stkCallback ?? callbackPayload?.stkCallback ?? callbackPayload;
  const resultCode = Number(callback?.ResultCode ?? 0);
  const callbackItems = callback?.CallbackMetadata?.Item ?? [];
  const failed = resultCode !== 0;

  const amountValue = callbackItems.find((item) => item.Name === 'Amount')?.Value ?? payment?.amount;
  const phoneValue = callbackItems.find((item) => item.Name === 'PhoneNumber')?.Value ?? payment?.phone;
  const receiptValue = callbackItems.find((item) => item.Name === 'MpesaReceiptNumber')?.Value ?? payment?.receipt_number;

  const normalizedPhone = normalizeKenyanPhone(phoneValue ?? '');
  const normalizedPendingPhone = normalizeKenyanPhone(payment?.phone ?? '');

  const isSuccessfulPayment = !failed && !!receiptValue && normalizedPhone && normalizedPendingPhone === normalizedPhone && Number(amountValue) === Number(payment?.amount);

  return {
    failed,
    amount: Number(amountValue),
    phone: normalizedPhone,
    receipt: String(receiptValue || ''),
    checkoutRequestId: callback?.CheckoutRequestID ?? payment?.checkout_request_id,
    merchantRequestId: callback?.MerchantRequestID ?? payment?.merchant_request_id,
    isSuccessfulPayment
  };
}

export function assertNoDuplicatePendingSale(pendingPayment) {
  if (pendingPayment && pendingPayment.status === 'pending') {
    return { duplicate: true, message: 'A pending M-Pesa STK request already exists for this sale.' };
  }

  return { duplicate: false, message: '' };
}

export function verifyMpesaCallback(payment, callbackPayload) {
  const callback = callbackPayload?.Body?.stkCallback ?? callbackPayload?.stkCallback ?? callbackPayload;
  const resultCode = Number(callback?.ResultCode ?? 0);
  const items = callback?.CallbackMetadata?.Item ?? [];
  const amountItem = items.find((item) => item.Name === 'Amount');
  const phoneItem = items.find((item) => item.Name === 'PhoneNumber');
  const receiptItem = items.find((item) => item.Name === 'MpesaReceiptNumber');

  const amount = Number(amountItem?.Value ?? payment?.amount ?? 0);
  const phone = normalizeKenyanPhone(phoneItem?.Value ?? payment?.phone ?? '');
  const receipt = String(receiptItem?.Value ?? payment?.receipt_number ?? '');

  if (resultCode !== 0) {
    return { action: 'failed', ok: false, reason: 'ResultCode is not success.' };
  }

  if (!receipt || !phone || !Number.isFinite(amount) || amount <= 0) {
    return { action: 'failed', ok: false, reason: 'Missing callback fields.' };
  }

  if (Number(payment?.amount) !== amount) {
    return { action: 'failed', ok: false, reason: 'Amount mismatch.' };
  }

  if (normalizeKenyanPhone(payment?.phone ?? '') !== phone) {
    return { action: 'failed', ok: false, reason: 'Phone mismatch.' };
  }

  return { action: 'paid', ok: true, amount, phone, receipt };
}
