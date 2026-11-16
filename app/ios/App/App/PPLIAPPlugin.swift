import Foundation
import Capacitor
import StoreKit

// In-app purchases with StoreKit 2 (iOS 15+). The page asks for products, starts a purchase and gets the signed transaction (JWS)
// back; the page sends it to the server (/iap/verify) and only calls finish() once the server has recorded it.
// Registered in PPLViewController (AppDelegate.swift) with the other local plugin.

// Keeps the transactions that are not finished yet, by transaction id.
private actor PPLTxStore {
    private var items: [String: Transaction] = [:]
    func put(_ t: Transaction) { items[String(t.id)] = t }
    func get(_ id: String) -> Transaction? { return items[id] }
    func remove(_ id: String) { items.removeValue(forKey: id) }
}

private func pplUnwrap(_ v: VerificationResult<Transaction>) -> Transaction {
    switch v {
    case .verified(let t): return t
    case .unverified(let t, _): return t   // the server decides what to do with it
    }
}

@objc(PPLIAPPlugin)
public class PPLIAPPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PPLIAPPlugin"
    public let jsName = "PPLIAP"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "products", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "buy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "entitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unfinished", returnType: CAPPluginReturnPromise)
    ]

    private let store = PPLTxStore()
    private var updatesTask: Task<Void, Never>?

    // Purchases that finish outside the app (Ask to Buy approved later, a purchase made on another device, a renewal) arrive here.
    override public func load() {
        updatesTask = Task { [weak self] in
            for await v in Transaction.updates {
                guard let self = self else { return }
                let t = pplUnwrap(v)
                await self.store.put(t)
                self.notifyListeners("tx", data: ["jws": v.jwsRepresentation, "txid": String(t.id)])
            }
        }
    }

    deinit { updatesTask?.cancel() }

    // products({ ids: [String] }) -> { products: [{ id, displayPrice }] }
    @objc func products(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self) else { call.reject("ids required"); return }
        Task {
            do {
                let list = try await Product.products(for: ids)
                let out: [[String: String]] = list.map { ["id": $0.id, "displayPrice": $0.displayPrice] }
                call.resolve(["products": out])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // buy({ id }) -> { status: 'success', jws, txid } | { status: 'cancelled' } | { status: 'pending' }. Does not finish the transaction.
    @objc func buy(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id required"); return }
        Task {
            do {
                guard let product = try await Product.products(for: [id]).first else { call.reject("product not found"); return }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    let t = pplUnwrap(verification)
                    await self.store.put(t)
                    call.resolve(["status": "success", "jws": verification.jwsRepresentation, "txid": String(t.id)])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                case .pending:
                    call.resolve(["status": "pending"])
                @unknown default:
                    call.resolve(["status": "pending"])
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // finish({ txid }) -> {}   (looks in the kept transactions first, then in Transaction.unfinished)
    @objc func finish(_ call: CAPPluginCall) {
        guard let txid = call.getString("txid") else { call.reject("txid required"); return }
        Task {
            if let t = await self.store.get(txid) {
                await t.finish()
                await self.store.remove(txid)
                call.resolve()
                return
            }
            for await v in Transaction.unfinished {
                let t = pplUnwrap(v)
                if String(t.id) == txid {
                    await t.finish()
                    call.resolve()
                    return
                }
            }
            call.reject("transaction not found")
        }
    }

    // entitlements() -> { jws: [String] }   (everything the user owns now, verified or not: the server decides)
    @objc func entitlements(_ call: CAPPluginCall) {
        Task {
            var list: [String] = []
            for await v in Transaction.currentEntitlements { list.append(v.jwsRepresentation) }
            call.resolve(["jws": list])
        }
    }

    // unfinished() -> { items: [{ jws, txid }] }
    @objc func unfinished(_ call: CAPPluginCall) {
        Task {
            var list: [[String: String]] = []
            for await v in Transaction.unfinished {
                let t = pplUnwrap(v)
                await self.store.put(t)
                list.append(["jws": v.jwsRepresentation, "txid": String(t.id)])
            }
            call.resolve(["items": list])
        }
    }
}
