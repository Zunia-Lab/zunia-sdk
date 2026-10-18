/// Error codes and explanations, the same as `@zunialab/sdk-core`.
library;

/// Codes the wallet puts on a refused request. The Zunia extension, Zunia
/// mobile and every SDK use this one list.
const List<String> zuniaProviderErrorCodes = [
  'USER_REJECTED',
  'NOT_CONNECTED',
  'LOCKED',
  'UNKNOWN_CHAIN',
  'ORIGIN_MISMATCH',
  'UNSUPPORTED',
  'INVALID_PARAMS',
  'INTERNAL',
];

/// Every code a [ZuniaConnectException] can carry.
///
/// The first group is [zuniaProviderErrorCodes]. The second covers the
/// connection itself.
abstract final class ZuniaErrorCode {
  /// The person declined in Zunia.
  static const userRejected = 'USER_REJECTED';

  /// There is no session, or the wallet no longer grants this app.
  static const notConnected = 'NOT_CONNECTED';

  /// The wallet stayed locked.
  static const locked = 'LOCKED';

  /// The wallet does not know the chain.
  static const unknownChain = 'UNKNOWN_CHAIN';

  /// The request named another site than the one asking.
  static const originMismatch = 'ORIGIN_MISMATCH';

  /// The wallet or this transport cannot do it.
  static const unsupported = 'UNSUPPORTED';

  /// The request is malformed, or too large for the relay.
  static const invalidParams = 'INVALID_PARAMS';

  /// The wallet failed.
  static const internal = 'INTERNAL';

  /// Zunia is not installed.
  static const notInstalled = 'NOT_INSTALLED';

  /// The wallet did not answer in time.
  static const timeout = 'TIMEOUT';

  /// The session ended while a request was pending.
  static const disconnected = 'DISCONNECTED';

  /// Pairing could not complete: bad key, undecryptable frame, relay refusal.
  static const pairingFailed = 'PAIRING_FAILED';

  /// The relay no longer knows the session. Pair again.
  static const sessionExpired = 'SESSION_EXPIRED';

  /// The relay could not be reached, or refused the frame.
  static const network = 'NETWORK';
}

/// Finer reasons behind a code, where the next step differs.
abstract final class ZuniaErrorReason {
  /// `TIMEOUT`: the wallet's prompt ran out before anyone answered.
  static const promptExpired = 'prompt-expired';

  /// `NETWORK`: the phone is offline and the relay's queue for it is full,
  /// so the request never reached it. Open Zunia, then try again.
  static const queueFull = 'queue-full';

  /// `INVALID_PARAMS`: the sealed request is larger than the relay's 512 KiB
  /// frame limit, so it was not sent.
  static const tooLarge = 'too-large';

  /// `UNSUPPORTED`: this Zunia build cannot show the transaction.
  static const blindSigning = 'blind-signing';
}

/// A failure from the wallet, the relay or this SDK.
class ZuniaConnectException implements Exception {
  /// Creates an exception with one of the [ZuniaErrorCode] values.
  const ZuniaConnectException(this.code, this.message,
      {this.reason, this.cause});

  /// One of [ZuniaErrorCode].
  final String code;

  /// What went wrong, in words.
  final String message;

  /// One of [ZuniaErrorReason], when the code alone does not say what to do.
  final String? reason;

  /// The underlying error, if any.
  final Object? cause;

  @override
  String toString() => 'ZuniaConnectException($code): $message';
}

final _promptExpired =
    RegExp('request expired before it was answered', caseSensitive: false);
final _blindSigning = RegExp('blind signing', caseSensitive: false);

/// True for a code in [zuniaProviderErrorCodes].
bool isZuniaProviderErrorCode(Object? value) =>
    value is String && zuniaProviderErrorCodes.contains(value);

/// Wraps anything into a [ZuniaConnectException], keeping the wallet's code
/// when it sent one.
ZuniaConnectException toZuniaConnectException(Object error,
    {String fallback = ZuniaErrorCode.internal}) {
  if (error is ZuniaConnectException) return error;
  final message = error is FormatException ? error.message : error.toString();
  if (_promptExpired.hasMatch(message)) {
    return ZuniaConnectException(ZuniaErrorCode.timeout, message,
        reason: ZuniaErrorReason.promptExpired, cause: error);
  }
  if (RegExp('request rejected|user rejected|rejected by user',
          caseSensitive: false)
      .hasMatch(message)) {
    return ZuniaConnectException(ZuniaErrorCode.userRejected, message,
        cause: error);
  }
  return ZuniaConnectException(fallback, message, cause: error);
}

/// The wallet's `{code, message}` error payload, as an exception.
ZuniaConnectException walletErrorFrom(
    Object? payload, String fallbackCode, String fallbackMessage) {
  final body = payload is Map ? payload : const <String, Object?>{};
  final rawCode = body['code'];
  final rawMessage = body['message'];
  final code =
      isZuniaProviderErrorCode(rawCode) ? rawCode as String : fallbackCode;
  final message = rawMessage is String && rawMessage.isNotEmpty
      ? (rawMessage.length > 300 ? rawMessage.substring(0, 300) : rawMessage)
      : fallbackMessage;
  final reason =
      code == ZuniaErrorCode.unsupported && _blindSigning.hasMatch(message)
          ? ZuniaErrorReason.blindSigning
          : _promptExpired.hasMatch(message)
              ? ZuniaErrorReason.promptExpired
              : null;
  return ZuniaConnectException(
    reason == ZuniaErrorReason.promptExpired ? ZuniaErrorCode.timeout : code,
    message,
    reason: reason,
  );
}

/// An error in words a person can act on, for a snackbar or an inline message.
class ZuniaErrorExplanation {
  /// Creates an explanation.
  const ZuniaErrorExplanation({
    required this.code,
    required this.title,
    required this.message,
    required this.retryable,
    required this.detail,
    this.reason,
  });

  /// One of [ZuniaErrorCode].
  final String code;

  /// One of [ZuniaErrorReason], if any.
  final String? reason;

  /// Two or three words.
  final String title;

  /// One or two sentences: what happened and what to do.
  final String message;

  /// Trying the same request again can succeed.
  final bool retryable;

  /// The original text, for a details fold.
  final String detail;
}

typedef _Copy = ({String title, String message, bool retryable});

const Map<String, _Copy> _reasonCopy = {
  ZuniaErrorReason.blindSigning: (
    title: 'Update Zunia',
    message:
        "This version of Zunia can't show this transaction, so nothing was signed. Update Zunia to the latest version, or use another wallet.",
    retryable: false,
  ),
  ZuniaErrorReason.promptExpired: (
    title: 'No answer in time',
    message: 'The Zunia prompt expired before it was answered. Try again.',
    retryable: true,
  ),
  ZuniaErrorReason.queueFull: (
    title: 'Phone offline',
    message:
        'Zunia is offline and too many requests are waiting for it. Open Zunia on your phone, then try again.',
    retryable: true,
  ),
  ZuniaErrorReason.tooLarge: (
    title: 'Request too large',
    message:
        'This request is larger than the relay accepts, so it was not sent. Split it into smaller transactions.',
    retryable: false,
  ),
};

const Map<String, _Copy> _codeCopy = {
  'USER_REJECTED': (
    title: 'Declined',
    message: 'You declined the request in your wallet. Nothing was signed.',
    retryable: true,
  ),
  'NOT_CONNECTED': (
    title: 'Not connected',
    message:
        'Your wallet is no longer connected to this app. Connect it again, then try again.',
    retryable: false,
  ),
  'LOCKED': (
    title: 'Wallet locked',
    message: 'Zunia stayed locked. Unlock it, then try again.',
    retryable: true,
  ),
  'UNKNOWN_CHAIN': (
    title: 'Network missing',
    message:
        'Your wallet does not have this network yet. Add it, then try again.',
    retryable: false,
  ),
  'ORIGIN_MISMATCH': (
    title: 'Wrong site',
    message:
        'The request named a different site than this one, so the wallet refused it.',
    retryable: false,
  ),
  'UNSUPPORTED': (
    title: 'Not supported',
    message: 'Your wallet does not support this request.',
    retryable: false,
  ),
  'INVALID_PARAMS': (
    title: 'Request refused',
    message:
        'The wallet refused the request as written. If you switched accounts, reconnect and try again.',
    retryable: false,
  ),
  'INTERNAL': (
    title: 'Wallet error',
    message: 'Your wallet could not complete the request.',
    retryable: true,
  ),
  'NOT_INSTALLED': (
    title: 'Zunia not found',
    message:
        'Zunia is not installed on this device. Install it, or scan the code with Zunia on another phone.',
    retryable: false,
  ),
  'TIMEOUT': (
    title: 'No answer in time',
    message:
        'Your wallet did not answer in time, so nothing was signed. Open Zunia, then try again.',
    retryable: true,
  ),
  'DISCONNECTED': (
    title: 'Disconnected',
    message:
        'The wallet session ended, so nothing was signed. Connect again, then try again.',
    retryable: false,
  ),
  'PAIRING_FAILED': (
    title: 'Pairing failed',
    message: 'The phone could not be paired. Scan a new code.',
    retryable: true,
  ),
  'SESSION_EXPIRED': (
    title: 'Session expired',
    message: 'The phone session expired. Pair again.',
    retryable: false,
  ),
  'NETWORK': (
    title: 'Connection problem',
    message:
        'The wallet relay could not be reached. Check your connection and try again.',
    retryable: true,
  ),
};

/// Any error this SDK threw, explained. Never throws.
ZuniaErrorExplanation explainZuniaError(Object error) {
  final failure = toZuniaConnectException(error);
  final copy = (failure.reason != null ? _reasonCopy[failure.reason] : null) ??
      _codeCopy[failure.code] ??
      _codeCopy['INTERNAL']!;
  return ZuniaErrorExplanation(
    code: failure.code,
    reason: failure.reason,
    title: copy.title,
    message: copy.message,
    retryable: copy.retryable,
    detail: failure.message,
  );
}
