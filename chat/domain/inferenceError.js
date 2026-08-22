const ACCESS_CREDIT_ERROR_TYPES = new Set([
    'payment_required',
    'token_limit_exceeded'
]);
const OPENROUTER_KEY_LIMIT_PATTERN = /\b(?:api\s+)?key(?:\s+spending)?\s+limit\s+(?:exceeded|reached|hit)\b/i;

export const ACCESS_REFRESH_FAILURE_MESSAGE =
    'Inference access could not be refreshed. Please try again shortly.';
export const ACCESS_OR_POLICY_RESTRICTION_MESSAGE =
    'This request was blocked by an access or policy restriction. Try again, or use a different request or model.';

export function getInferenceErrorStatus(error) {
    const responseData = error?.data || error?.responseData || null;
    return [
        error?.status,
        error?.code,
        responseData?.error?.code,
        responseData?.code
    ]
        .filter(value => (
            (typeof value === 'number' && Number.isFinite(value)) ||
            (typeof value === 'string' && value.trim() !== '')
        ))
        .map(value => typeof value === 'number' ? value : Number(value.trim()))
        .find(value => Number.isFinite(value));
}

export function getInferenceErrorType(error) {
    const responseData = error?.data || error?.responseData || null;
    const value = [
        error?.errorType,
        error?.error_type,
        error?.metadata?.error_type,
        responseData?.error?.metadata?.error_type,
        responseData?.error?.error_type,
        responseData?.error_type
    ].find(candidate => typeof candidate === 'string' && candidate.trim() !== '');

    if (typeof value !== 'string') return null;
    return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isAccessCreditExhaustedError(error) {
    const responseData = error?.data || error?.responseData || null;
    const status = getInferenceErrorStatus(error);
    if (status !== 402 && status !== 403) return false;

    const errorType = getInferenceErrorType(error);
    if (errorType !== null) {
        return ACCESS_CREDIT_ERROR_TYPES.has(errorType);
    }

    const details = [
        error?.message,
        responseData?.error?.message,
        responseData?.detail,
        responseData?.message
    ].filter(Boolean).join(' ');

    if (status === 403) {
        return OPENROUTER_KEY_LIMIT_PATTERN.test(details);
    }

    const normalizedDetails = details.toLowerCase();
    return normalizedDetails.includes('credit') ||
        normalizedDetails.includes('can only afford') ||
        normalizedDetails.includes('more credits') ||
        normalizedDetails.includes('max_tokens');
}

export function getSafeInferenceErrorMessage(error, fallback = 'Request failed.') {
    if (isAccessCreditExhaustedError(error)) {
        return ACCESS_REFRESH_FAILURE_MESSAGE;
    }
    if (getInferenceErrorStatus(error) === 403) {
        return ACCESS_OR_POLICY_RESTRICTION_MESSAGE;
    }
    return typeof fallback === 'string' && fallback.trim()
        ? fallback
        : 'Request failed.';
}
