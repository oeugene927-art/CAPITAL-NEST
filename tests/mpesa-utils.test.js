import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoDuplicatePendingSale,
  createStkPushRequest,
  getDarajaBaseUrl,
  isPositiveWholeKesAmount,
  isValidKenyanPhone,
  normalizeKenyanPhone,
  requestDarajaStkPush,
  requestDarajaToken,
  verifyMpesaCallback
} from '../supabase/functions/_shared/mpesa-utils.js';

test('validates Kenyan phone numbers and normalizes them', () => {
  assert.equal(normalizeKenyanPhone('0712345678'), '254712345678');
  assert.equal(normalizeKenyanPhone('254712345678'), '254712345678');
  assert.equal(isValidKenyanPhone('254712345678'), true);
  assert.equal(isValidKenyanPhone('254112345678'), true);
  assert.equal(isValidKenyanPhone('0712345678'), true);
  assert.equal(isValidKenyanPhone('254812345678'), false);
  assert.equal(isValidKenyanPhone('12345'), false);
});

test('enforces positive whole-number KES amounts', () => {
  assert.equal(isPositiveWholeKesAmount(100), true);
  assert.equal(isPositiveWholeKesAmount(0), false);
  assert.equal(isPositiveWholeKesAmount(-5), false);
  assert.equal(isPositiveWholeKesAmount(25.5), false);
});

test('duplicate pending STK attempts are blocked', () => {
  const duplicate = assertNoDuplicatePendingSale({ status: 'pending', checkout_request_id: 'ws_CO_123' });
  assert.equal(duplicate.duplicate, true);
  assert.match(duplicate.message, /pending/i);
});

test('Daraja OAuth token request is retrievable with mocked fetch', async () => {
  const calls = [];

  const result = await requestDarajaToken({
    baseUrl: 'https://sandbox.safaricom.co.ke',
    consumerKey: 'key',
    consumerSecret: 'secret',
    fetchFn: async (url, options) => {
      calls.push({ url, headers: options.headers });
      return {
        ok: true,
        json: async () => ({ access_token: 'token-123' })
      };
    }
  });

  assert.equal(result.access_token, 'token-123');
  assert.equal(calls[0].url, 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
  assert.match(calls[0].headers.Authorization, /Basic /);
});

test('Daraja STK request payload is built for paybill and till configuration', () => {
  const payload = createStkPushRequest({
    amount: 250,
    phoneNumber: '0712345678',
    shortcode: '174379',
    shortcodeType: 'paybill',
    passkey: 'test-passkey',
    callbackUrl: 'https://example.com/callback',
    accountReference: 'Sale 123',
    transactionDescription: 'Demo sale',
    partyA: '254712345678',
    timestamp: '20250101120000'
  });

  assert.equal(payload.BusinessShortCode, '174379');
  assert.equal(payload.TransactionType, 'CustomerPayBillOnline');
  assert.equal(payload.Amount, 250);
  assert.equal(payload.PhoneNumber, 254712345678);
  assert.equal(payload.CallBackURL, 'https://example.com/callback');
  assert.equal(payload.AccountReference, 'Sale 123');
});

test('failed callback state is detected without marking a sale paid', () => {
  const payment = { id: 'payment-1', amount: 250, phone: '254712345678', checkout_request_id: 'ws_CO_1', merchant_request_id: 'ws_REQ_1' };
  const callback = {
    Body: {
      stkCallback: {
        ResultCode: 1,
        ResultDesc: 'Transaction failed',
        CheckoutRequestID: 'ws_CO_1',
        MerchantRequestID: 'ws_REQ_1'
      }
    }
  };

  const result = verifyMpesaCallback(payment, callback);
  assert.equal(result.action, 'failed');
  assert.equal(result.ok, false);
});

test('successful callback verifies amount, phone number and receipt before marking paid', () => {
  const payment = { amount: 250, phone: '254712345678', checkout_request_id: 'ws_CO_1', merchant_request_id: 'ws_REQ_1' };
  const callback = {
    Body: {
      stkCallback: {
        ResultCode: 0,
        CheckoutRequestID: 'ws_CO_1',
        MerchantRequestID: 'ws_REQ_1',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 250 },
            { Name: 'MpesaReceiptNumber', Value: 'ABC123QZ' },
            { Name: 'PhoneNumber', Value: 254712345678 }
          ]
        }
      }
    }
  };

  const result = verifyMpesaCallback(payment, callback);
  assert.equal(result.action, 'paid');
  assert.equal(result.ok, true);
  assert.equal(result.receipt, 'ABC123QZ');
});

test('repeated callback attempts are idempotent', () => {
  const payment = { amount: 250, phone: '254712345678', checkout_request_id: 'ws_CO_1', merchant_request_id: 'ws_REQ_1' };
  const callback = {
    Body: {
      stkCallback: {
        ResultCode: 0,
        CheckoutRequestID: 'ws_CO_1',
        MerchantRequestID: 'ws_REQ_1',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 250 },
            { Name: 'MpesaReceiptNumber', Value: 'ABC123QZ' },
            { Name: 'PhoneNumber', Value: 254712345678 }
          ]
        }
      }
    }
  };

  const first = verifyMpesaCallback(payment, callback);
  const second = verifyMpesaCallback(payment, callback);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.receipt, second.receipt);
});

test('Daraja STK push request handler can be mocked without reaching the network', async () => {
  const result = await requestDarajaStkPush({
    baseUrl: 'https://sandbox.safaricom.co.ke',
    accessToken: 'token',
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_111', MerchantRequestID: 'ws_REQ_111', ResponseDescription: 'Accepted' })
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.response.CheckoutRequestID, 'ws_CO_111');
  assert.equal(getDarajaBaseUrl('sandbox'), 'https://sandbox.safaricom.co.ke');
});

