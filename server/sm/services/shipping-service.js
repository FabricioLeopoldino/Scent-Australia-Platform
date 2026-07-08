const https = require('https')

function easypostRequest(method, path, body) {
  const key = process.env.EASYPOST_API_KEY
  if (!key) return Promise.reject(new Error('EASYPOST_API_KEY not configured'))
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${key}:`).toString('base64')
    const bodyStr = body ? JSON.stringify(body) : null
    const opts = {
      hostname: 'api.easypost.com',
      path: `/v2${path}`,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }
    const req = https.request(opts, resp => {
      let data = ''
      resp.on('data', c => data += c)
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(data) }) }
        catch { resolve({ status: resp.statusCode, data }) }
      })
    })
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

module.exports = { easypostRequest }
