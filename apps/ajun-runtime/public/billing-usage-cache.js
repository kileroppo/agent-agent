export function createBillingUsageCache({ load, now = () => Date.now(), ttlMs = 60_000 }) {
    let billing = null;
    let loadedAt = 0;
    let inFlight = null;
    return {
        peek: () => billing,
        replace(value) {
            billing = value;
            loadedAt = now();
            return billing;
        },
        async read({ force = false } = {}) {
            if (!force && billing && now() - loadedAt < ttlMs)
                return billing;
            if (inFlight)
                return inFlight;
            inFlight = Promise.resolve(load()).then((payload) => {
                if (!payload?.billing)
                    throw new Error('用量接口没有返回账本数据。');
                billing = payload.billing;
                loadedAt = now();
                return billing;
            }).finally(() => { inFlight = null; });
            return inFlight;
        },
    };
}
