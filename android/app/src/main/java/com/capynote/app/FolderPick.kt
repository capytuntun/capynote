package com.capynote.app

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * 「匯入整個資料夾」。網站用的是 <input webkitdirectory>，Android 的 WebView 沒有對應的選取器，
 * 所以 inject.js 把那個 input 的點擊攔下來改叫 Bridge.pickFolder()：這裡開系統的「選擇資料夾」
 * （ACTION_OPEN_DOCUMENT_TREE），把整棵樹走一遍，再把清單交回網頁。
 *
 * 檔案內容不經 JS 字串搬運：每個檔案對應一個同源的假網址 /__capynote/pick/<token>/<序號>，
 * MainActivity 的 shouldInterceptRequest 認得它，直接用 ContentResolver 串流給 fetch()。
 * 同源所以網站的 CSP（connect-src 'self'）放行；token 隨機、只給發起的那個頁面，用完就丟。
 */
class FolderPick(private val cr: ContentResolver) {
    private val TAG = "capynote"

    class Entry(val uri: Uri, val path: String, val name: String, val mime: String, val size: Long)
    class Pick(val token: String, val root: String, val files: List<Entry>, val skipped: Int)

    private val picks = HashMap<String, Pick>()

    companion object {
        const val PREFIX = "/__capynote/pick/"
        const val MAX_FILES = 2000
        const val MAX_FILE_BYTES = 200L * 1024 * 1024   // 單檔上限；更大的略過並在清單裡回報
    }

    /** 在背景執行緒跑：把 tree 走完。 */
    fun walk(tree: Uri): Pick {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = nameOf(tree, rootId) ?: "folder"
        val out = ArrayList<Entry>()
        var skipped = 0
        fun visit(docId: String, dir: String) {
            if (out.size >= MAX_FILES) return
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
            val cols = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE
            )
            val c = runCatching { cr.query(children, cols, null, null, null) }.getOrNull() ?: return
            c.use {
                while (it.moveToNext()) {
                    if (out.size >= MAX_FILES) break
                    val id = it.getString(0) ?: continue
                    val name = it.getString(1) ?: continue
                    val mime = it.getString(2) ?: ""
                    val size = if (it.isNull(3)) 0L else it.getLong(3)
                    if (name.startsWith(".")) continue   // .git、.DS_Store、.obsidian 之類
                    val path = "$dir/$name"
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        visit(id, path)
                    } else if (size > MAX_FILE_BYTES) {
                        skipped++
                    } else {
                        out.add(Entry(DocumentsContract.buildDocumentUriUsingTree(tree, id), path, name, mime, size))
                    }
                }
            }
        }
        visit(rootId, rootName)
        val token = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val p = Pick(token, rootName, out, skipped)
        synchronized(picks) { picks.clear(); picks[token] = p }   // 一次只會有一個選取在進行
        Log.i(TAG, "folder pick: ${out.size} files under '$rootName', skipped $skipped")
        return p
    }

    private fun nameOf(tree: Uri, docId: String): String? {
        val u = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
        val c = runCatching { cr.query(u, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null) }.getOrNull()
            ?: return null
        c.use { return if (it.moveToFirst()) it.getString(0) else null }
    }

    /** 交給網頁的清單（inject.js 的 window.__capyFolderPicked）。 */
    fun toJson(p: Pick): String {
        val files = JSONArray()
        p.files.forEachIndexed { i, e ->
            files.put(JSONObject().put("i", i).put("path", e.path).put("name", e.name).put("type", e.mime).put("size", e.size))
        }
        return JSONObject().put("token", p.token).put("root", p.root).put("skipped", p.skipped).put("files", files).toString()
    }

    fun release(token: String) {
        synchronized(picks) { picks.remove(token) }
    }

    /** shouldInterceptRequest 用：是我們的假網址就回檔案內容，否則 null 讓它照常上網。 */
    fun intercept(path: String?): WebResourceResponse? {
        if (path == null || !path.startsWith(PREFIX)) return null
        val parts = path.removePrefix(PREFIX).split('/')
        if (parts.size != 2) return notFound()
        val p = synchronized(picks) { picks[parts[0]] } ?: return notFound()
        val idx = parts[1].toIntOrNull() ?: return notFound()
        val e = p.files.getOrNull(idx) ?: return notFound()
        val stream = runCatching { cr.openInputStream(e.uri) }.getOrNull() ?: return notFound()
        val mime = e.mime.ifBlank { "application/octet-stream" }
        return WebResourceResponse(mime, null, 200, "OK", mapOf("Cache-Control" to "no-store"), stream)
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
}
