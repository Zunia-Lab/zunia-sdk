/// Connect Flutter apps to the Zunia wallet over zunia.connect.v2: QR
/// pairing, deep links on the same phone, Cosmos signing and sign-in.
///
/// Start with [ZuniaConnectClient]; show [ZuniaPairingView] while it pairs.
library;

export 'src/client.dart';
export 'src/connect_button.dart';
export 'src/connect_crypto.dart'
    show
        ConnectRole,
        ConnectKeyPair,
        ConnectSessionKeys,
        ConnectCipher,
        ConnectEnvelope,
        SealedFrame,
        connectTranscript,
        deriveConnectKeys,
        verificationCodeFrom,
        frameAad,
        encryptFrame,
        decryptFrame;
export 'src/constants.dart';
export 'src/errors.dart';
export 'src/links.dart';
export 'src/pairing_uri.dart';
export 'src/pairing_view.dart';
export 'src/sign_in.dart';
export 'src/storage.dart';
export 'src/types.dart';
