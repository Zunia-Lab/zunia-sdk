/// Where a paired session survives an app restart.
///
/// The saved record holds the session's encryption keys and relay token, so
/// back it with the platform keystore, for example `flutter_secure_storage`:
///
/// ```dart
/// class SecureSessionStorage implements ZuniaSessionStorage {
///   const SecureSessionStorage(this.storage);
///   final FlutterSecureStorage storage;
///   @override
///   Future<String?> read(String key) => storage.read(key: key);
///   @override
///   Future<void> write(String key, String value) =>
///       storage.write(key: key, value: value);
///   @override
///   Future<void> delete(String key) => storage.delete(key: key);
/// }
/// ```
abstract interface class ZuniaSessionStorage {
  /// The value saved under [key], or null.
  Future<String?> read(String key);

  /// Saves [value] under [key].
  Future<void> write(String key, String value);

  /// Removes [key].
  Future<void> delete(String key);
}

/// Keeps the session in memory only: it ends with the app.
class MemorySessionStorage implements ZuniaSessionStorage {
  /// Creates an empty store.
  MemorySessionStorage();

  final Map<String, String> _values = {};

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async => _values[key] = value;

  @override
  Future<void> delete(String key) async => _values.remove(key);
}
