import Foundation
import Capacitor
import AuthenticationServices

// Sign in with Apple, natively: Apple's own sheet (Face ID, no password),
// then the identity token goes to Supabase (signInWithIdToken in app.js).
// The authorization code is passed back too, so the server can keep Apple's
// refresh token and revoke it if the account is deleted (App Store rule).
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]
    private var pending: CAPPluginCall?

    @objc func authorize(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            // The SHA-256 of the nonce; Supabase checks it against the raw one.
            if let nonce = call.getString("nonce") { request.nonce = nonce }
            self.pending = call
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            pending?.reject("Apple didn't send an identity token.", "NO_TOKEN")
            pending = nil
            return
        }
        let code = credential.authorizationCode.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        // Apple only shares the name and email the first time someone signs in.
        pending?.resolve([
            "identityToken": token,
            "authorizationCode": code,
            "user": credential.user,
            "email": credential.email ?? "",
            "givenName": credential.fullName?.givenName ?? "",
            "familyName": credential.fullName?.familyName ?? "",
        ])
        pending = nil
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        pending?.reject(canceled ? "Canceled" : error.localizedDescription, canceled ? "CANCELED" : "FAILED")
        pending = nil
    }
}
