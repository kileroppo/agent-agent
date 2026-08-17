export function createBillingUsageCache({ load, now = () => Date.now(), ttlMs = 60_000 }: any): any {
    let billing: any = null;
    let loadedAt = 0;
    let inFlight: Promise<any> | null = null;
    return {
        peek: (): any => billing,
        replace(value: any): any {
            billing = value;
            loadedAt = now();
            return billing;
        },
        async read({ force = false }: any = {}): Promise<any> {
            if (!force && billing && now() - loadedAt < ttlMs)
                return billing;
            if (inFlight)
                return inFlight;
            inFlight = Promise.resolve(load()).then((payload: any): any => {
                if (!payload?.billing)
                    throw new Error('用量接口没有返回账本数据。');
                billing = payload.billing;
                loadedAt = now();
                return billing;
            }).finally((): any => { inFlight = null; });
            return inFlight;
        },
    };
}
