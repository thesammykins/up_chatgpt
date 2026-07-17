import Foundation
import LocalAuthentication
import Security

let service = "com.codex.up-banking"

func fail(_ message: String, _ status: OSStatus? = nil) -> Never {
    if let status {
        FileHandle.standardError.write(Data("\(message) (status \(status)).\n".utf8))
    } else {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }
    exit(1)
}

func account() -> String {
    guard CommandLine.arguments.count == 3 else {
        fail("Usage: up-banking-keychain.swift <store|read|delete> <account>")
    }
    let value = CommandLine.arguments[2]
    guard !value.isEmpty, value.utf8.count <= 128, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
        fail("Invalid Keychain account name")
    }
    return value
}

func baseQuery(_ account: String) -> [CFString: Any] {
    [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
    ]
}

func accessControl() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let control = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        .userPresence,
        &error
    ) else {
        let description = error?.takeRetainedValue().localizedDescription ?? "unknown error"
        fail("Could not create Keychain access control: \(description)")
    }
    return control
}

let action = CommandLine.arguments.dropFirst().first ?? ""
let keychainAccount = account()

switch action {
case "store":
    let token = FileHandle.standardInput.readDataToEndOfFile()
    guard !token.isEmpty, token.count <= 4096, !token.contains(0), !token.contains(10), !token.contains(13) else {
        fail("Invalid Up credential")
    }
    let deleteStatus = SecItemDelete(baseQuery(keychainAccount) as CFDictionary)
    guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
        fail("Could not replace the Keychain credential", deleteStatus)
    }
    var query = baseQuery(keychainAccount)
    query[kSecAttrAccessControl] = accessControl()
    query[kSecValueData] = token
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
        fail("Could not store the Keychain credential", status)
    }
case "read":
    var query = baseQuery(keychainAccount)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    let context = LAContext()
    context.localizedReason = "Unlock Up Banking for Codex"
    query[kSecUseAuthenticationContext] = context
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let token = result as? Data, !token.isEmpty, token.count <= 4096 else {
        fail("Keychain authentication was not completed", status)
    }
    FileHandle.standardOutput.write(token)
case "delete":
    let status = SecItemDelete(baseQuery(keychainAccount) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        fail("Could not remove the Keychain credential", status)
    }
default:
    fail("Usage: up-banking-keychain.swift <store|read|delete> <account>")
}
