package dev.agentdeck.ui.eink

import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.viewinterop.AndroidView
import dev.agentdeck.terrarium.renderer.EinkRefreshHelper
import dev.agentdeck.terrarium.renderer.einkColorEnabled
import kotlinx.coroutines.delay

/**
 * E-ink partial refresh mode — controls how a region is updated on screen.
 */
enum class RefreshMode {
    /** Full GC16 refresh — flash, no ghosting. For terrarium creatures. */
    FULL,
    /** DU (direct update) — fast, slight ghosting. For usage gauges. */
    DU,
    /** A2 (animation mode) — fastest, binary. For state markers, timeline. */
    A2,
}

/**
 * Wraps Compose content in an AndroidView bridge that enables
 * vendor-specific partial refresh control on e-ink displays.
 *
 * When [triggerKey] changes, the zone requests a refresh with the given
 * [mode] after [debounceMs] milliseconds of stability.
 *
 * On non-e-ink devices or unsupported vendors, falls back to standard invalidation.
 */
@Composable
fun EinkRefreshZone(
    mode: RefreshMode,
    debounceMs: Long,
    triggerKey: Any,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    // Keep a snapshot-backed reference to the latest content lambda so
    // the inner ComposeView (created once in AndroidView.factory) always
    // recomposes with the current state instead of the stale capture.
    val currentContent by rememberUpdatedState(content)

    // Track the view reference for vendor API calls
    var viewRef by remember { mutableStateOf<View?>(null) }
    var lastTrigger by remember { mutableLongStateOf(0L) }

    // Debounced refresh on trigger change
    LaunchedEffect(triggerKey) {
        val now = System.currentTimeMillis()
        lastTrigger = now
        delay(debounceMs)

        // Only refresh if no newer trigger arrived during debounce
        if (lastTrigger == now) {
            val view = viewRef
            if (view != null) {
                when (mode) {
                    RefreshMode.FULL -> EinkRefreshHelper.requestFullRefresh(view)
                    RefreshMode.DU -> EinkRefreshHelper.requestDURefresh(view)
                    RefreshMode.A2 -> EinkRefreshHelper.requestA2Refresh(view)
                }
            }
        }
    }

    // Use AndroidView as bridge to get a real View reference
    AndroidView(
        factory = { context ->
            FrameLayout(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                // Embed Compose content inside this View
                val composeView = ComposeView(context).apply {
                    setContent { currentContent() }
                }
                addView(composeView)
                viewRef = this
            }
        },
        modifier = modifier,
    )
}

/**
 * E-ink refresh zone for animated content (terrarium aquarium).
 *
 * Unlike [EinkRefreshZone] which only refreshes on [stateKey] changes,
 * this zone receives per-frame callbacks from the animation loop and
 * triggers appropriate EPD refreshes:
 * - Animation frames → GC16 partial (no flash, 16-level grayscale)
 * - State transitions → Full GC16 with flash (ghosting clear)
 *
 * The [content] lambda receives an `onFrameRendered` callback that the
 * child composable (e.g. [EinkAquariumFrame]) should invoke after each render.
 */
@Composable
fun EinkAnimatedRefreshZone(
    stateKey: Any,
    modifier: Modifier = Modifier,
    content: @Composable (onFrameRendered: (isAnimationFrame: Boolean) -> Unit) -> Unit,
) {
    val currentContent by rememberUpdatedState(content)
    var viewRef by remember { mutableStateOf<View?>(null) }

    // State transition → full GC16 refresh (debounced to avoid rapid flashes)
    LaunchedEffect(stateKey) {
        delay(500)
        viewRef?.let { EinkRefreshHelper.requestFullRefresh(it) }
    }

    AndroidView(
        factory = { context ->
            FrameLayout(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                // B&W e-ink: software layer for EPD grayscale path.
                // Color e-ink keeps a GPU layer so RKCFA can sample the color framebuffer.
                if (!einkColorEnabled) {
                    setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                }
                val composeView = ComposeView(context).apply {
                    setContent {
                        currentContent { isAnimationFrame ->
                            val view = viewRef ?: return@currentContent
                            if (isAnimationFrame) {
                                EinkRefreshHelper.requestAnimationRefresh(view)
                            } else {
                                EinkRefreshHelper.requestFullRefresh(view)
                            }
                        }
                    }
                }
                addView(composeView)
                viewRef = this
            }
        },
        modifier = modifier,
    )
}
