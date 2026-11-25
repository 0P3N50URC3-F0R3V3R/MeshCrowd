package com.meshcrowd.app

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray

// Direct Share: the page's recent destinations become launcher/share-sheet shortcuts. Ids are the page's destination
// keys ("dm:5", "ch:2:9"); anything else is dropped.
object ShareShortcuts {
    const val CATEGORY = "com.meshcrowd.app.category.SHARE_TARGET"
    const val MAX = 4
    private val ID = Regex("""^(dm:\d{1,12}|ch:\d{1,12}:\d{1,12})$""")

    fun parse(json: String): List<Pair<String, String>> {
        val arr = try { JSONArray(json) } catch (_: Exception) { return emptyList() }
        val out = ArrayList<Pair<String, String>>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("id")
            val label = o.optString("label").replace(Regex("""\s+"""), " ").trim().take(40)
            if (ID.matches(id) && label.isNotEmpty() && out.none { it.first == id }) out.add(id to label)
            if (out.size == MAX) break
        }
        return out
    }

    fun publish(context: Context, json: String) {
        val items = parse(json)
        val shortcuts = items.map { (id, label) ->
            ShortcutInfoCompat.Builder(context, id)
                .setShortLabel(label)
                .setLongLabel(label)
                .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                .setCategories(setOf(CATEGORY))
                .setIntent(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_DEFAULT))
                .setLongLived(true)
                .build()
        }
        try {
            ShortcutManagerCompat.removeAllDynamicShortcuts(context)
            if (shortcuts.isNotEmpty()) ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
        } catch (_: Exception) { /* launcher refused: sharing still works without shortcuts */ }
    }

    fun clear(context: Context) {
        try { ShortcutManagerCompat.removeAllDynamicShortcuts(context) } catch (_: Exception) { }
    }
}
