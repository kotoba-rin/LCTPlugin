<?php
/**
 * Plugin Name: LCTP Library API Statistics
 * Description: Administrator-only aggregate request counts for the public library metadata API.
 * Version: 1.1.1
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

function lctp_library_stats_table() {
    global $wpdb;
    return $wpdb->prefix . 'lctp_library_api_daily';
}

function lctp_library_stats_hourly_table() {
    global $wpdb;
    return $wpdb->prefix . 'lctp_library_api_hourly';
}

function lctp_library_stats_install() {
    global $wpdb;
    if (get_option('lctp_library_stats_schema') === '2') {
        return true;
    }
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = lctp_library_stats_table();
    $hourly = lctp_library_stats_hourly_table();
    $charset = $wpdb->get_charset_collate();
    $previous = $wpdb->suppress_errors(true);
    try {
        dbDelta("CREATE TABLE $table (
            request_date date NOT NULL,
            status_code smallint unsigned NOT NULL,
            request_count bigint unsigned NOT NULL DEFAULT 0,
            last_called_at datetime NOT NULL,
            PRIMARY KEY  (request_date,status_code)
        ) $charset;");
        dbDelta("CREATE TABLE $hourly (
            request_date date NOT NULL,
            request_hour tinyint unsigned NOT NULL,
            status_code smallint unsigned NOT NULL,
            request_count bigint unsigned NOT NULL DEFAULT 0,
            last_called_at datetime NOT NULL,
            PRIMARY KEY  (request_date,request_hour,status_code)
        ) $charset;");
        foreach (array($table, $hourly) as $required_table) {
            if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($required_table))) !== $required_table) {
                return false;
            }
        }
        add_option('lctp_library_stats_enabled_at', gmdate('Y-m-d H:i:s'), '', false);
        add_option('lctp_library_stats_hourly_enabled_at', gmdate('Y-m-d H:i:s'), '', false);
        update_option('lctp_library_stats_schema', '2', false);
        return true;
    } finally {
        $wpdb->suppress_errors($previous);
    }
}

function lctp_library_stats_record($status) {
    global $wpdb;
    $status = (int) $status;
    if ($status < 100 || $status > 599) {
        return false;
    }
    if (!lctp_library_stats_install()) {
        error_log('LCTP library API statistics: statistics storage is unavailable.');
        return false;
    }
    $now = current_datetime();
    $day = $now->format('Y-m-d');
    $hour = (int) $now->format('G');
    $utc = $now->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    $table = lctp_library_stats_hourly_table();
    // The old daily table remains read-only history. Each new request has one atomic write.
    $sql = $wpdb->prepare(
        "INSERT INTO $table (request_date,request_hour,status_code,request_count,last_called_at) VALUES (%s,%d,%d,1,%s)
         ON DUPLICATE KEY UPDATE request_count=request_count+1,last_called_at=GREATEST(last_called_at,%s)",
        $day, $hour, $status, $utc, $utc
    );
    $previous = $wpdb->suppress_errors(true);
    try {
        $result = $wpdb->query($sql);
    } finally {
        $wpdb->suppress_errors($previous);
    }
    if ($result === false) {
        error_log('LCTP library API statistics: request count could not be saved.');
    }
    return $result !== false;
}

function lctp_library_stats_track($served, $response, $request, $server) {
    $route = rtrim($request->get_route(), '/');
    if (!$served && strcasecmp($route, '/lctp/v1/project/stats') === 0) {
        // Permission failures and REST envelopes do not carry the callback's cache headers.
        $server->send_header('Cache-Control', 'private, no-store');
    } elseif (strcasecmp($route, '/lctp/v1/project') === 0 && $request->get_method() === 'GET'
        && ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
        try {
            lctp_library_stats_record($response->get_status());
        } catch (Throwable $error) {
            error_log('LCTP library API statistics: request count could not be saved.');
        }
    }
    return $served;
}

function lctp_library_stats_permission() {
    return current_user_can('manage_options');
}

function lctp_library_stats_range($start = null, $end = null) {
    // Do calendar arithmetic on the site's date without midnight DST transitions.
    $calendar = new DateTimeZone('UTC');
    $today = new DateTimeImmutable(current_datetime()->format('Y-m-d'), $calendar);
    if (($start === null && $end === null) || ($start === '' && $end === '')) {
        return array('start' => $today->modify('-29 days'), 'end' => $today, 'today' => $today);
    }
    $dates = array();
    foreach (array($start, $end) as $value) {
        if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $value)) {
            return new WP_Error('lctp_stats_invalid_range', '请同时填写有效的开始日期和结束日期。', array('status' => 400));
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value, $calendar);
        if (!$date || $date->format('Y-m-d') !== $value) {
            return new WP_Error('lctp_stats_invalid_range', '日期格式应为有效的年-月-日。', array('status' => 400));
        }
        $dates[] = $date;
    }
    if ($dates[0] > $dates[1] || $dates[1] > $today || $dates[0]->diff($dates[1])->days > 365) {
        return new WP_Error('lctp_stats_invalid_range', '结束日期不能晚于今天，开始日期不能晚于结束日期，单次最多查询 366 天。', array('status' => 400));
    }
    return array('start' => $dates[0], 'end' => $dates[1], 'today' => $today);
}

function lctp_library_stats_add_count(&$bucket, $status, $count) {
    $bucket['total'] += $count;
    if ($status >= 200 && $status < 300) {
        $bucket['success'] += $count;
    } elseif ($status === 304) {
        $bucket['not_modified'] += $count;
    } elseif ($status >= 400) {
        $bucket['errors'] += $count;
    }
}

function lctp_library_stats_read($start = null, $end = null) {
    global $wpdb;
    $range = lctp_library_stats_range($start, $end);
    if (is_wp_error($range)) {
        return $range;
    }
    if (!lctp_library_stats_install()) {
        return new WP_Error('lctp_stats_unavailable', '暂时无法读取文库接口统计。', array('status' => 503));
    }
    $today = $range['today']->format('Y-m-d');
    $week_start = $range['today']->modify('-6 days')->format('Y-m-d');
    $month_start = $range['today']->modify('-29 days')->format('Y-m-d');
    $table = lctp_library_stats_table();
    $hourly_table = lctp_library_stats_hourly_table();
    $start_date = $range['start']->format('Y-m-d');
    $end_date = $range['end']->format('Y-m-d');
    $source = "(SELECT request_date,status_code,request_count,last_called_at FROM $table
                UNION ALL SELECT request_date,status_code,request_count,last_called_at FROM $hourly_table) AS api_requests";
    // Read all three aggregates in one statement so new requests cannot split the report across snapshots.
    $sql = $wpdb->prepare(
        "SELECT NULL AS day_bucket,NULL AS hour_bucket,status_code,SUM(request_count) AS total,
         SUM(CASE WHEN request_date=%s THEN request_count ELSE 0 END) AS today,
         SUM(CASE WHEN request_date BETWEEN %s AND %s THEN request_count ELSE 0 END) AS last_7_days,
         SUM(CASE WHEN request_date BETWEEN %s AND %s THEN request_count ELSE 0 END) AS last_30_days,
         MAX(last_called_at) AS last_called_at,0 AS legacy_count FROM $source GROUP BY status_code
         UNION ALL
         SELECT request_date,NULL,status_code,request_count,0,0,0,NULL,request_count FROM $table
         WHERE request_date BETWEEN %s AND %s
         UNION ALL
         SELECT request_date,NULL,status_code,SUM(request_count),0,0,0,NULL,0 FROM $hourly_table
         WHERE request_date BETWEEN %s AND %s GROUP BY request_date,status_code
         UNION ALL
         SELECT NULL,request_hour,status_code,SUM(request_count),0,0,0,NULL,0 FROM $hourly_table
         WHERE request_date BETWEEN %s AND %s GROUP BY request_hour,status_code
         ORDER BY status_code",
        $today, $week_start, $today, $month_start, $today, $start_date, $end_date, $start_date, $end_date, $start_date, $end_date
    );
    $previous = $wpdb->suppress_errors(true);
    try {
        $rows = $wpdb->get_results($sql, ARRAY_A);
        $read_error = $wpdb->last_error;
    } finally {
        $wpdb->suppress_errors($previous);
    }
    if (!is_array($rows) || $read_error !== '') {
        return new WP_Error('lctp_stats_unavailable', '暂时无法读取文库接口统计。', array('status' => 503));
    }
    $summary = array('total' => 0, 'today' => 0, 'last_7_days' => 0, 'last_30_days' => 0);
    $statuses = array();
    $last_called = null;
    $daily = array();
    $legacy_requests = 0;
    for ($date = $range['end']; $date >= $range['start']; $date = $date->modify('-1 day')) {
        $day = $date->format('Y-m-d');
        $daily[$day] = array('date' => $day, 'total' => 0, 'success' => 0, 'not_modified' => 0, 'errors' => 0);
    }
    $hourly = array();
    for ($hour = 0; $hour < 24; $hour++) {
        $hourly[$hour] = array('hour' => $hour, 'total' => 0, 'success' => 0, 'not_modified' => 0, 'errors' => 0);
    }
    foreach ($rows as $row) {
        $count = (int) $row['total'];
        $status = (int) $row['status_code'];
        if ($row['day_bucket'] !== null) {
            $day = $row['day_bucket'];
            if (isset($daily[$day])) {
                $legacy_requests += (int) $row['legacy_count'];
                lctp_library_stats_add_count($daily[$day], $status, $count);
            }
        } elseif ($row['hour_bucket'] !== null) {
            $hour = (int) $row['hour_bucket'];
            if (isset($hourly[$hour])) {
                lctp_library_stats_add_count($hourly[$hour], $status, $count);
            }
        } else {
            foreach (array_keys($summary) as $key) {
                $summary[$key] += (int) $row[$key];
            }
            $statuses[] = array('status' => $status, 'count' => $count);
            if ($last_called === null || $row['last_called_at'] > $last_called) {
                $last_called = $row['last_called_at'];
            }
        }
    }
    $range_totals = array('start' => $start_date, 'end' => $end_date, 'total' => 0, 'success' => 0, 'not_modified' => 0, 'errors' => 0);
    foreach ($daily as $row) {
        foreach (array('total', 'success', 'not_modified', 'errors') as $key) {
            $range_totals[$key] += $row[$key];
        }
    }
    $range_totals['legacy_requests'] = $legacy_requests;
    return array(
        'enabled_at' => get_option('lctp_library_stats_enabled_at'),
        'hourly_enabled_at' => get_option('lctp_library_stats_hourly_enabled_at'),
        'timezone' => wp_timezone_string(),
        'endpoint' => rest_url('lctp/v1/project'),
        'summary' => $summary,
        'by_status' => $statuses,
        'daily' => array_values($daily),
        'range' => $range_totals,
        'hourly' => $hourly,
        'last_called_at' => $last_called,
    );
}

function lctp_library_stats_response($request = null) {
    $stats = lctp_library_stats_read($request ? $request->get_param('start') : null, $request ? $request->get_param('end') : null);
    if (is_wp_error($stats)) {
        $status = $stats->get_error_code() === 'lctp_stats_invalid_range' ? 400 : 503;
        return new WP_REST_Response(array('code' => $stats->get_error_code(), 'message' => $stats->get_error_message()), $status, array('Cache-Control' => 'private, no-store'));
    }
    return new WP_REST_Response($stats, 200, array('Cache-Control' => 'private, no-store'));
}

function lctp_library_stats_display_time($utc) {
    return $utc ? wp_date('Y-m-d H:i:s', strtotime($utc . ' UTC'), wp_timezone()) : '暂无调用';
}

function lctp_library_stats_page() {
    if (!lctp_library_stats_permission()) {
        wp_die('你没有查看文库接口统计的权限。', '', array('response' => 403));
    }
    $start = isset($_GET['start']) ? wp_unslash($_GET['start']) : null;
    $end = isset($_GET['end']) ? wp_unslash($_GET['end']) : null;
    $stats = lctp_library_stats_read($start, $end);
    echo '<div class="wrap"><h1>文库接口统计</h1>';
    if (is_wp_error($stats)) {
        echo '<div class="notice notice-error"><p>' . esc_html($stats->get_error_message()) . '</p></div>';
        echo '<p><a class="button" href="' . esc_url(admin_url('tools.php?page=lctp-library-stats')) . '">返回默认统计</a></p></div>';
        return;
    }
    echo '<p>统计接口：<code>GET ' . esc_html($stats['endpoint']) . '</code></p>';
    echo '<p>统计启用：' . esc_html(lctp_library_stats_display_time($stats['enabled_at'])) . '；时区：' . esc_html($stats['timezone']) . '；最近调用：' . esc_html(lctp_library_stats_display_time($stats['last_called_at'])) . '。</p>';
    echo '<style>
        .lctp-stats-cards{display:flex;flex-wrap:wrap;gap:16px;margin:20px 0}
        .lctp-stats-card{background:#fff;border:1px solid #c3c4c7;padding:16px 24px;min-width:140px}
        .lctp-stats-card strong{display:block;font-size:28px;margin-top:8px}
        .lctp-stats-filter{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0}
        .lctp-stats-chart-wrap{max-width:1100px;overflow-x:auto;background:#fff;border:1px solid #c3c4c7;padding:20px 12px}
        .lctp-stats-chart{display:flex;align-items:end;gap:6px;min-width:600px;height:190px}
        .lctp-stats-hour{flex:1;min-width:0;text-align:center}
        .lctp-stats-bar{height:140px;display:flex;align-items:end;justify-content:center}
        .lctp-stats-bar span{display:block;width:75%;background:#2271b1;min-width:5px}
        .lctp-stats-hour small{display:block;margin-top:6px;color:#50575e}
        .lctp-stats-count{display:block;font-size:11px;margin-bottom:4px}
        .lctp-stats-help{max-width:1100px;line-height:1.7}
    </style>';
    echo '<div class="lctp-stats-cards">';
    foreach (array('total' => '累计调用', 'today' => '今日调用', 'last_7_days' => '近 7 天', 'last_30_days' => '近 30 天') as $key => $label) {
        echo '<div class="lctp-stats-card"><div>' . esc_html($label) . '</div><strong>' . esc_html(number_format_i18n($stats['summary'][$key])) . '</strong></div>';
    }
    echo '</div><p class="lctp-stats-help">每次到达 WordPress 的 GET 请求计 1 次，包含 304 缓存校验和失败响应。HEAD、OPTIONS、后台查看统计不计入。次数不代表下载量或使用人数；不含静态清单、ZIP、正文与附件下载，也不含启用前历史请求。仅保存日期、小时、响应状态和汇总次数，不保存 IP、访问者标识或请求内容。</p>';
    $page = isset($_GET['page']) && is_string($_GET['page']) ? wp_unslash($_GET['page']) : 'lctp-library-stats';
    if (!in_array($page, array('lctp-library-stats', 'lctp-library-stats-plugin', 'lctp-library-stats-matomo'), true)) {
        $page = 'lctp-library-stats';
    }
    echo '<h2>选择统计时间段</h2><form method="get" class="lctp-stats-filter">';
    echo '<input type="hidden" name="page" value="' . esc_attr($page) . '">';
    echo '<label>开始日期 <input type="date" name="start" required value="' . esc_attr($stats['range']['start']) . '"></label>';
    echo '<label>结束日期 <input type="date" name="end" required max="' . esc_attr(current_datetime()->format('Y-m-d')) . '" value="' . esc_attr($stats['range']['end']) . '"></label>';
    echo '<button type="submit" class="button button-primary">查看统计</button>';
    foreach (array(1 => '今天', 7 => '近 7 天', 30 => '近 30 天') as $days => $label) {
        $query = array('page' => $page, 'start' => current_datetime()->modify('-' . ($days - 1) . ' days')->format('Y-m-d'), 'end' => current_datetime()->format('Y-m-d'));
        echo '<a class="button" href="?' . esc_attr(http_build_query($query)) . '">' . esc_html($label) . '</a>';
    }
    echo '</form><p><strong>所选时间段：' . esc_html($stats['range']['start']) . ' 至 ' . esc_html($stats['range']['end']) . '，共 ' . esc_html(number_format_i18n($stats['range']['total'])) . ' 次调用。</strong> 日期含首尾两天，最多查询 366 天。</p>';
    echo '<h2>一天中各时段的调用分布</h2><p>将所选日期范围内的调用按站点时区汇总到 00—23 时。</p>';
    echo '<p class="lctp-stats-help">小时统计开始于 ' . esc_html(lctp_library_stats_display_time($stats['hourly_enabled_at'])) . '。所选范围内有 ' . esc_html(number_format_i18n($stats['range']['legacy_requests'])) . ' 次旧版调用仅有日期，已保留在累计和每日统计中，不分摊到小时。</p>';
    $maximum = max(1, max(array_column($stats['hourly'], 'total')));
    echo '<div class="lctp-stats-chart-wrap"><div class="lctp-stats-chart" role="img" aria-label="所选日期内各小时的调用次数，详细数字见下方表格">';
    foreach ($stats['hourly'] as $row) {
        $height = $row['total'] > 0 ? max(1, (int) round(100 * $row['total'] / $maximum)) : 0;
        echo '<div class="lctp-stats-hour"><span class="lctp-stats-count">' . esc_html($row['total']) . '</span><div class="lctp-stats-bar"><span style="height:' . esc_attr($height) . '%"></span></div><small>' . esc_html(sprintf('%02d', $row['hour'])) . '</small></div>';
    }
    echo '</div></div><details style="margin:16px 0"><summary>查看每小时时段明细</summary><table class="widefat striped" style="max-width:960px"><thead><tr><th>时段</th><th>调用总数</th><th>正常返回（2xx）</th><th>缓存校验（304）</th><th>失败（4xx / 5xx）</th></tr></thead><tbody>';
    foreach ($stats['hourly'] as $row) {
        echo '<tr><td>' . esc_html(sprintf('%02d:00—%02d:59', $row['hour'], $row['hour'])) . '</td>';
        foreach (array('total', 'success', 'not_modified', 'errors') as $key) {
            echo '<td>' . esc_html(number_format_i18n($row[$key])) . '</td>';
        }
        echo '</tr>';
    }
    echo '</tbody></table></details>';
    echo '<h2>累计响应状态</h2><table class="widefat striped" style="max-width:760px"><thead><tr><th>HTTP 状态</th><th>调用次数</th></tr></thead><tbody>';
    if (!$stats['by_status']) {
        echo '<tr><td colspan="2">暂无调用</td></tr>';
    }
    foreach ($stats['by_status'] as $row) {
        $labels = array(200 => '正常返回', 304 => '版本未变化', 401 => '未认证', 403 => '无权限', 503 => '文库暂不可用');
        $label = $row['status'] . (isset($labels[$row['status']]) ? ' · ' . $labels[$row['status']] : '');
        echo '<tr><td>' . esc_html($label) . '</td><td>' . esc_html(number_format_i18n($row['count'])) . '</td></tr>';
    }
    echo '</tbody></table><h2>所选时间段的每日调用</h2><table class="widefat striped" style="max-width:960px"><thead><tr><th>日期</th><th>调用总数</th><th>正常返回（2xx）</th><th>缓存校验（304）</th><th>失败（4xx / 5xx）</th></tr></thead><tbody>';
    foreach ($stats['daily'] as $row) {
        echo '<tr><td>' . esc_html($row['date']) . '</td>';
        foreach (array('total', 'success', 'not_modified', 'errors') as $key) {
            echo '<td>' . esc_html(number_format_i18n($row[$key])) . '</td>';
        }
        echo '</tr>';
    }
    echo '</tbody></table></div>';
}

add_action('admin_init', 'lctp_library_stats_install');
add_action('admin_menu', function () {
    add_management_page('文库接口统计', '文库接口统计', 'manage_options', 'lctp-library-stats', 'lctp_library_stats_page');
    add_submenu_page('plugins.php', '文库接口统计', '文库接口统计', 'manage_options', 'lctp-library-stats-plugin', 'lctp_library_stats_page');
    global $submenu;
    if (isset($submenu['matomo'])) {
        add_submenu_page('matomo', '文库接口统计', '文库接口统计', 'manage_options', 'lctp-library-stats-matomo', 'lctp_library_stats_page');
    }
}, 99);
add_action('rest_api_init', function () {
    register_rest_route('lctp/v1', '/project/stats', array(
        'methods' => 'GET',
        'callback' => 'lctp_library_stats_response',
        'permission_callback' => 'lctp_library_stats_permission',
    ));
});
// Observe the outer HTTP response once, after enveloping and internal REST dispatch.
add_filter('rest_pre_serve_request', 'lctp_library_stats_track', 0, 4);
