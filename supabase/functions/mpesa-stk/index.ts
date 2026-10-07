import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  assertNoDuplicatePendingSale,
  getDarajaBaseUrl,
  isPositiveWholeKesAmount,
  isValidKenyanPhone,
  normalizeKenyanPhone,
  requestDarajaStkPush,
  requestDarajaToken,
  createStkPushRequest
} from '../_shared/mpesa-utils.js';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const mpesaConsumerKey = Deno.env.get('MPESA_CONSUMER_KEY');
const mpesaConsumerSecret = Deno.env.get('MPESA_CONSUMER_SECRET');
const mpesaShortcode = Deno.env.get('MPESA_SHORTCODE');
const mpesaPasskey = Deno.env.get('MPESA_PASSKEY');
const mpesaEnv = Deno.env.get('MPESA_ENV') || 'sandbox';
const mpesaShortcodeType = Deno.env.get('MPESA_SHORTCODE_TYPE') || 'paybill';
const mpesaCallbackUrl = Deno.env.get('MPESA_CALLBACK_URL');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed. Use POST.' });
  }

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(500, { error: 'Supabase service configuration is missing.' });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse(401, { error: 'Missing bearer token.' });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse(401, { error: 'Invalid or expired user session.' });
  }

  const payload = await req.json().catch(() => ({}));
  const saleId = String(payload.sale_id || '').trim();
  const phoneNumber = normalizeKenyanPhone(String(payload.phone_number || payload.phone || ''));

  if (!saleId) {
    return jsonResponse(400, { error: 'A sale_id value is required.' });
  }

  if (!isValidKenyanPhone(phoneNumber)) {
    return jsonResponse(400, { error: 'Phone number must be a valid Kenyan mobile number in 2547XXXXXXXX or 2541XXXXXXXX format.' });
  }

  const { data: sale, error: saleError } = await supabase
    .from('sales')
    .select('*')
    .eq('id', saleId)
    .maybeSingle();

  if (saleError || !sale) {
    return jsonResponse(404, { error: 'Sale not found.' });
  }

  if (sale.user_id !== userData.user.id) {
    return jsonResponse(403, { error: 'The selected sale does not belong to the signed-in user.' });
  }

  if (sale.payment_method !== 'mpesa') {
    return jsonResponse(400, { error: 'Only M-Pesa sales can be processed through STK.' });
  }

  if (sale.status !== 'pending') {
    return jsonResponse(409, { error: 'This sale is not pending and cannot be charged again.' });
  }

  if (!isPositiveWholeKesAmount(sale.amount)) {
    return jsonResponse(400, { error: 'Sale amount must be a positive whole-number KES amount.' });
  }

  const { data: pendingPayment, error: pendingPaymentError } = await supabase
    .from('payments')
    .select('*')
    .eq('sale_id', saleId)
    .eq('status', 'pending')
    .maybeSingle();

  if (pendingPaymentError) {
    return jsonResponse(500, { error: pendingPaymentError.message || 'Could not check pending payments.' });
  }

  const duplicate = assertNoDuplicatePendingSale(pendingPayment);
  if (duplicate.duplicate) {
    return jsonResponse(409, { error: duplicate.message, checkout_request_id: pendingPayment.checkout_request_id, merchant_request_id: pendingPayment.merchant_request_id });
  }

  if (!mpesaConsumerKey || !mpesaConsumerSecret || !mpesaShortcode || !mpesaPasskey || !mpesaCallbackUrl) {
    return jsonResponse(500, { error: 'Daraja credentials are missing. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, and MPESA_CALLBACK_URL.' });
  }

  const baseUrl = getDarajaBaseUrl(mpesaEnv);
  const accessTokenResponse = await requestDarajaToken({
    baseUrl,
    consumerKey: mpesaConsumerKey,
    consumerSecret: mpesaConsumerSecret
  }).catch((error) => {
    throw new Error(error.message || 'Daraja OAuth request failed.');
  });

  const token = accessTokenResponse.access_token;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const requestPayload = createStkPushRequest({
    amount: sale.amount,
    phoneNumber,
    shortcode: mpesaShortcode,
    shortcodeType: mpesaShortcodeType,
    passkey: mpesaPasskey,
    callbackUrl: mpesaCallbackUrl,
    accountReference: `Sale ${sale.id.slice(0, 8)}`,
    transactionDescription: `Capital Nest sale ${sale.id}`,
    partyA: phoneNumber,
    timestamp
  });

  const stkResponse = await requestDarajaStkPush({
    baseUrl,
    accessToken: token,
    payload: requestPayload
  });

  if (!stkResponse.ok || !stkResponse.response?.CheckoutRequestID) {
    const failureMessage = stkResponse.response?.errorMessage || stkResponse.response?.ResponseDescription || 'M-Pesa rejected the STK push.';

    const { error: insertError } = await supabase.from('payments').insert({
      sale_id: sale.id,
      user_id: userData.user.id,
      amount: Number(sale.amount),
      method: 'mpesa',
      status: 'failed',
      phone: phoneNumber,
      checkout_request_id: null,
      merchant_request_id: null,
      callback_payload: { error: failureMessage, response: stkResponse.response }
    });

    if (insertError) {
      console.error('Failed to record payment failure: ', insertError);
    }

    return jsonResponse(502, {
      error: failureMessage,
      status: 'failed',
      sale_id: sale.id,
      amount: Number(sale.amount)
    });
  }

  const now = new Date().toISOString();
  const paymentInfo = {
    sale_id: sale.id,
    user_id: userData.user.id,
    amount: Number(sale.amount),
    method: 'mpesa',
    status: 'pending',
    phone: phoneNumber,
    checkout_request_id: stkResponse.response.CheckoutRequestID,
    merchant_request_id: stkResponse.response.MerchantRequestID,
    callback_payload: { response: stkResponse.response },
    created_at: now,
    updated_at: now
  };

  const { error: paymentError } = await supabase.from('payments').upsert(paymentInfo, { onConflict: 'sale_id' });
  if (paymentError) {
    return jsonResponse(500, { error: paymentError.message || 'Unable to record pending payment.' });
  }

  const { error: saleUpdateError } = await supabase.from('sales').update({
    checkout_request_id: stkResponse.response.CheckoutRequestID,
    merchant_request_id: stkResponse.response.MerchantRequestID,
    phone: phoneNumber,
    updated_at: now
  }).eq('id', sale.id);

  if (saleUpdateError) {
    return jsonResponse(500, { error: saleUpdateError.message || 'Unable to save request IDs for the sale.' });
  }

  return jsonResponse(202, {
    status: 'pending',
    sale_id: sale.id,
    amount: Number(sale.amount),
    phone_number: phoneNumber,
    checkout_request_id: stkResponse.response.CheckoutRequestID,
    merchant_request_id: stkResponse.response.MerchantRequestID,
    message: 'M-Pesa STK Push request accepted. Await callback confirmation.'
  });
});
