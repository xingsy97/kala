#!/usr/bin/env node
const publicOrigin=process.env.RUNLAB_PUBLIC_ORIGIN;const issuer=process.env.OIDC_ISSUER
if(!publicOrigin||!issuer)throw new Error('RUNLAB_PUBLIC_ORIGIN and OIDC_ISSUER are required')
const discovery=await fetch(`${issuer}/.well-known/openid-configuration`).then((r)=>r.json());if(discovery.issuer!==issuer)throw new Error('issuer mismatch')
const login=await fetch(`${publicOrigin}/auth/login`,{redirect:'manual'});const location=login.headers.get('location')??'';if(!location.startsWith(`${issuer}/oauth/v2/authorize`))throw new Error(`unexpected login redirect ${location}`)
const redirect=new URL(location).searchParams.get('redirect_uri');if(redirect!==`${publicOrigin}/auth/callback`)throw new Error(`callback mismatch ${redirect}`)
const probe=new URL('/socket.io/?EIO=4&transport=polling',publicOrigin);const response=await fetch(probe);if(response.status!==401&&!response.ok)throw new Error(`Socket.IO edge returned ${response.status}`)
console.log(`PASS cloudflare profile issuer=${issuer} callback=${redirect} socketEdge=${response.status}`)
