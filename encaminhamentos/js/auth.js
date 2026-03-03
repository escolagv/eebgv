import { db, safeQuery } from './core.js';

export async function signIn(email, password) {
    return await db.auth.signInWithPassword({ email, password });
}

export async function signOut() {
    return await db.auth.signOut();
}

export async function requireAdminSession() {
    const { data: sessionData } = await db.auth.getSession();
    const session = sessionData?.session || null;
    if (!session) return { session: null, profile: null };

    try {
        const { data } = await safeQuery(
            db.from('usuarios')
                .select('papel, nome, status')
                .eq('user_uid', session.user.id)
                .single()
        );
        if (!data || data.status !== 'ativo' || data.papel !== 'admin') {
            await signOut();
            return { session: null, profile: null };
        }
        return { session, profile: data };
    } catch (err) {
        await signOut();
        return { session: null, profile: null };
    }
}
