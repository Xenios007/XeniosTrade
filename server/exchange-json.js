// Binance now issues order / algo / trade ids larger than 2^53 (9007199254740991) (e.g. 8389766281691711000). JSON.parse turns those into a rounded double, so
// a follow-up such as "GET /fapi/v1/order?orderId=..." asks for an order that does not exist, right after a real fill. Quoting the id keys' large
// integers before parsing keeps them exact strings; every consumer already sends them back as strings in query parameters.

const ID_KEYS = 'orderId|algoId|id|tradeId|orderListId|strategyId|origClientOrderId'
const LARGE_ID = new RegExp(`("(?:${ID_KEYS})"\\s*:\\s*)(-?\\d{16,})(?=\\s*[,}\\]])`, 'g')

/** Response text with integer ids of 16+ digits turned into JSON strings (everything else untouched). */
export function quoteLargeIntegers(text) {
  // Only ids a double cannot hold exactly are quoted; smaller ones stay numbers, so nothing else in the app changes shape.
  return String(text).replace(LARGE_ID, (match, prefix, digits) => (Number.isSafeInteger(Number(digits)) ? match : `${prefix}"${digits}"`))
}
