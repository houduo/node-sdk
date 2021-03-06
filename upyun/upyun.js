import createReq from './create-req'
import utils from './utils'
import formUpload from './form-upload'
import axios from 'axios'
import sign from './sign'

export default class Upyun {
  /**
   * @param {object} bucket - a instance of Bucket class
   * @param {object} params - optional params
   * @param {callback} getHeaderSign - callback function to get header sign
   */
  constructor (bucket, params = {}, getHeaderSign = null) {
    const isBrowser = typeof window !== 'undefined'

    if (typeof bucket.bucketName === 'undefined') {
      throw new Error('upyun - must config bucketName')
    }

    if (typeof params === 'function') {
      getHeaderSign = params
      params = {}
    }

    if (typeof getHeaderSign !== 'function' && isBrowser) {
      throw new Error('upyun - must config a callback function getHeaderSign in client side')
    }

    if (!isBrowser && (
        typeof bucket.operatorName === 'undefined' ||
        typeof bucket.password === 'undefined'
      )) {
      throw new Error('upyun - must config operateName and password in server side')
    }
    this.isBrowser = isBrowser

    const config = Object.assign({
      domain: 'v0.api.upyun.com',
      protocol: 'https'
    }, params)
    this.endpoint = config.protocol + '://' + config.domain

    this.req = createReq(this.endpoint, bucket, getHeaderSign || defaultGetHeaderSign)
    this.bucket = bucket
    if (!isBrowser)  {
      this.setBodySignCallback(sign.getPolicyAndAuthorization)
    }
  }

  setBucket (bucket) {
    this.bucket = bucket
    this.req.defaults.baseURL = this.endpoint + '/' + this.bucketName
  }

  setBodySignCallback (getBodySign) {
    if (typeof getBodySign !== 'function') {
      throw new Error('upyun - getBodySign should be a function')
    }
    this.bodySignCallback = getBodySign
  }

  usage (path = '/') {
    return this.req.get(path + '?usage').then(({data}) => {
      return Promise.resolve(data)
    })
  }

  listDir (path = '/', {limit = 100, order = 'asc', iter = ''} = {}) {
    const requestHeaders = {
      'x-list-limit': limit,
      'x-list-order': order
    }

    if (iter) {
      requestHeaders['x-list-iter'] = iter
    }

    return this.req.get(path, {
      headers: requestHeaders
    }).then(({data, headers, status}) => {
      if (status === 404) {
        return false
      }

      const next = headers['x-upyun-list-iter']
      if (!data) {
        return Promise.resolve({
          files: [],
          next
        })
      }

      const items = data.split('\n')
      const files = items.map(item => {
        const [name, type, size, time] = item.split('\t')
        return {
          name,
          type,
          size: parseInt(size),
          time: parseInt(time)
        }
      })

      return Promise.resolve({
        files,
        next
      })
    })
  }

  /**
   * @param localFile: file content, available type is Stream | String | Buffer for server; File | String for client
   * @see https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/send
   * @see https://github.com/mzabriskie/axios/blob/master/lib/adapters/http.js#L32
   */
  putFile (remotePath, localFile, options = {}) {
    // optional params
    const keys = ['Content-MD5', 'Content-Length', 'Content-Type', 'Content-Secret', 'x-gmkerl-thumb']
    let headers = {}
    keys.forEach(key => {
      const lower = key.toLowerCase()
      const finded = options[key] || options[lower]
      if (finded) {
        headers[key] = finded
      } else if (isMeta(key)) {
        headers[key] = options[key]
      }
    })

    return this.req.put(remotePath, localFile, {
      headers
    }).then(({headers: responseHeaders, status}) => {
      if (status !== 200) {
        return Promise.resolve(false)
      }

      let params = ['x-upyun-width', 'x-upyun-height', 'x-upyun-file-type', 'x-upyun-frames']
      let result = {}
      params.forEach(item => {
        let key = item.split('x-upyun-')[1]
        if (responseHeaders[item]) {
          result[key] = responseHeaders[item]
          if (key !== 'file-type') {
            result[key] = parseInt(result[key], 10)
          }
        }
      })
      return Promise.resolve(Object.keys(result).length > 0 ? result : true)
    })
  }

  makeDir (remotePath) {
    return this.req.post(remotePath, null, {
      headers: { folder: 'true' }
    }).then(({status}) => {
      return Promise.resolve(status === 200)
    })
  }

  headFile (remotePath) {
    return this.req.head(remotePath).then(({headers, status}) => {
      if (status === 404) {
        return Promise.resolve(false)
      }

      let params = ['x-upyun-file-type', 'x-upyun-file-size', 'x-upyun-file-date', 'Content-Md5']
      let result = {}
      params.forEach(item => {
        let key = item.split('x-upyun-file-')[1]
        if (headers[item]) {
          result[key] = headers[item]
          if (key === 'size' || key === 'date') {
            result[key] = parseInt(result[key], 10)
          }
        }
      })
      return Promise.resolve(result)
    })
  }

  deleteFile (remotePath) {
    return this.req.delete(remotePath).then(({status}) => {
      return Promise.resolve(status === 200)
    })
  }

  deleteDir (remotePath) {
    return this.deleteFile(remotePath)
  }

  getFile (remotePath, saveStream = null) {
    if (saveStream && typeof window !== 'undefined') {
      throw new Error('upyun - save as stream are only available on the server side.')
    }

    return this.req({
      method: 'GET',
      url: remotePath,
      responseType: saveStream ? 'stream' : null
    }).then((response) => {
      if (response.status === 404) {
        return Promise.resolve(false)
      }

      if (!saveStream) {
        return Promise.resolve(response.data)
      }

      const stream = response.data.pipe(saveStream)

      return new Promise((resolve, reject) => {
        stream.on('finish', () => resolve(stream))

        stream.on('error', reject)
      })
    })
  }

  updateMetadata (remotePath, metas, operate = 'merge') {
    let metaHeaders = {}
    for (let key in metas) {
      if (!isMeta(key)) {
        metaHeaders['x-upyun-meta-' + key] = metas[key]
      } else {
        metaHeaders[key] = metas
      }
    }

    return this.req.patch(
      remotePath + '?metadata=' + operate,
      null,
      { headers: metaHeaders }
    ).then(({status}) => {
      return Promise.resolve(status === 200)
    })
  }

  // be careful: this will download the entire file
  getMetadata (remotePath) {
    return this.req.get(remotePath).then(({headers, status}) => {
      if (status !== 200) {
        return Promise.resolve(false)
      }

      let result = {}
      for (let key in headers) {
        if (isMeta(key)) {
          result[key] = headers[key]
        }
      }

      return Promise.resolve(result)
    })
  }

  /**
   * in browser: type of fileOrPath is File
   * in server: type of fileOrPath is string: local file path
   */
  blockUpload (remotePath, fileOrPath, options = {}) {
    const isBrowser = typeof window !== 'undefined'

    let fileSizePromise
    let contentType
    if (isBrowser) {
      fileSizePromise = Promise.resolve(fileOrPath.size)
      contentType = fileOrPath.type
    } else {
      fileSizePromise = utils.getFileSizeAsync(fileOrPath)
      contentType = utils.getContentType(fileOrPath)
    }

    return fileSizePromise.then((fileSize) => {
      Object.assign(options, {
        'x-upyun-multi-stage': 'initiate',
        'x-upyun-multi-length': fileSize,
        'x-upyun-multi-type': contentType
      })

      const blockSize = 1024 * 1024
      const blocks = Math.ceil(fileSize / blockSize)

      return this.req.put(remotePath, null, {
        headers: options
      }).then(({headers}) => {
        let uuid = headers['x-upyun-multi-uuid']
        let nextId = headers['x-upyun-next-part-id']

        let p = Promise.resolve(nextId)
        for (let index = 0; index < blocks; index++) {
          p = p.then((nextId) => {
            const start = nextId * blockSize
            const end = Math.min(start + blockSize, fileSize)
            const blockPromise = utils.readBlockAsync(fileOrPath, start, end)
            return blockPromise.then((block) => {
              return this.req.put(remotePath, block, {
                headers: {
                  'x-upyun-multi-stage': 'upload',
                  'x-upyun-multi-uuid': uuid,
                  'x-upyun-part-id': nextId
                }
              }).then(({headers}) => {
                nextId = headers['x-upyun-next-part-id']
                return Promise.resolve(nextId)
              })
            })
          })
        }

        return p.then(() => {
          return this.req.put(remotePath, null, {
            headers: {
              'x-upyun-multi-stage': 'complete',
              'x-upyun-multi-uuid': uuid
            }
          }).then(({status}) => {
            return Promise.resolve(status === 204 || status === 201)
          })
        })
      })
    })
  }

  formPutFile (remotePath, localFile, params = {}) {
    if (typeof this.bodySignCallback !== 'function') {
      throw new Error('upyun - must setBodySignCallback first!')
    }

    params['bucket'] = this.bucket.bucketName
    params['save-key'] = remotePath
    let result = this.bodySignCallback(this.bucket, params)
    if (typeof result.then !== 'function') {
      result = Promise.resolve(result)
    }

    return result.then((bodySign) => {
      return formUpload(this.endpoint + '/' + params['bucket'], localFile, bodySign)
        .then((result) => {
          return Promise.resolve(result)
        })
    })
  }

  purge (urls) {
    if (typeof urls === 'string') {
      urls = [urls]
    }
    const headers = sign.getPurgeHeaderSign(this.bucket, urls)
    return axios.post(
      'http://purge.upyun.com/purge/',
      'purge=' + urls.join('\n'), {
      headers
    }).then(({data}) => {
      if(Object.keys(data.invalid_domain_of_url).length === 0) {
        return true
      } else {
        throw new Error('some url purge failed ' + data.invalid_domain_of_url.join(' '))
      }
    }, (err) => {
      throw new Error('upyun - request failed: ' + err.message)
    })
  }
}

function isMeta (key) {
  return key.indexOf('x-upyun-meta-') === 0
}

function defaultGetHeaderSign (bucket, method, path) {
  const headers = sign.getHeaderSign(bucket, method, path)
  return Promise.resolve(headers)
}
