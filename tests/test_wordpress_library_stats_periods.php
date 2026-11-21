<?php
/** Independent calendar/hourly regression fixtures for library API statistics. */
define('ABSPATH', sys_get_temp_dir() . '/lctp-stats-periods-' . bin2hex(random_bytes(5)) . '/');
define('ARRAY_A', 'ARRAY_A');
require __DIR__ . '/wordpress_library_stats_sql_fixture.php';
mkdir(ABSPATH . 'wp-admin/includes', 0755, true);
file_put_contents(ABSPATH . 'wp-admin/includes/upgrade.php', "<?php\n");

$GLOBALS['period_options'] = array(
    'lctp_library_stats_schema' => '1',
    'lctp_library_stats_enabled_at' => '2026-11-10 10:00:00',
);
$GLOBALS['period_now'] = new DateTimeImmutable('2026-11-11 00:30:00', new DateTimeZone('Asia/Shanghai'));
$GLOBALS['period_ddl'] = array();

function period_check($condition, $message) {
    if (!$condition) { throw new RuntimeException($message); }
}
function add_action(...$arguments) {}
function add_filter(...$arguments) {}
function get_option($key, $default = false) { return $GLOBALS['period_options'][$key] ?? $default; }
function add_option($key, $value, ...$arguments) {
    if (array_key_exists($key, $GLOBALS['period_options'])) { return false; }
    $GLOBALS['period_options'][$key] = $value;
    return true;
}
function update_option($key, $value, ...$arguments) { $GLOBALS['period_options'][$key] = $value; return true; }
function current_datetime() {
    return empty($GLOBALS['period_clock']) ? $GLOBALS['period_now'] : array_shift($GLOBALS['period_clock']);
}
function wp_timezone() { return $GLOBALS['period_now']->getTimezone(); }
function wp_timezone_string() { return wp_timezone()->getName(); }
function home_url($path = '') { return 'https://example.org' . $path; }
function rest_url($path = '') { return home_url('/wp-json/' . ltrim($path, '/')); }
function is_wp_error($value) { return $value instanceof WP_Error; }
function dbDelta($sql) {
    $GLOBALS['period_ddl'][] = $sql;
    if (preg_match('/CREATE\s+TABLE\s+`?([a-zA-Z0-9_]+)/i', $sql, $match)) {
        $GLOBALS['wpdb']->tables[$match[1]] = true;
    }
    return array();
}
class WP_Error {
    private $code;
    private $message;
    private $data;
    public function __construct($code, $message, $data = null) {
        $this->code = $code; $this->message = $message; $this->data = $data;
    }
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
    public function get_error_data($code = '') { return $this->data; }
}
class WP_REST_Response {
    private $data;
    private $status;
    private $headers;
    public function __construct($data = null, $status = 200, $headers = array()) {
        $this->data = $data; $this->status = $status; $this->headers = $headers;
    }
    public function get_data() { return $this->data; }
    public function get_status() { return $this->status; }
    public function get_headers() { return $this->headers; }
}
class PeriodRequest {
    private $parameters;
    public function __construct($parameters = array()) { $this->parameters = $parameters; }
    public function get_param($key) { return $this->parameters[$key] ?? null; }
}

/**
 * Capture counter writes separately from the fixtures used for report reads.
 */
class PeriodDatabase {
    public $prefix = 'period_';
    public $tables = array('period_lctp_library_api_daily' => true);
    public $legacy = array();
    public $hourly = array();
    public $hourly_read_extra = array();
    public $queries = array();
    public $reads = array();
    public $last_error = '';
    private $suppressed = false;
    public function get_charset_collate() { return 'DEFAULT CHARACTER SET utf8mb4'; }
    public function suppress_errors($value = true) {
        $previous = $this->suppressed; $this->suppressed = $value; return $previous;
    }
    public function esc_like($value) { return addcslashes($value, '_%\\'); }
    public function prepare($sql, ...$arguments) {
        if (count($arguments) === 1 && is_array($arguments[0])) { $arguments = $arguments[0]; }
        $index = 0;
        return preg_replace_callback('/%[sdf]/', function ($match) use (&$index, $arguments) {
            period_check(array_key_exists($index, $arguments), 'SQL placeholders must be bound.');
            $value = $arguments[$index++];
            if ($match[0] === '%d') { return (string) (int) $value; }
            if ($match[0] === '%f') { return (string) (float) $value; }
            return "'" . str_replace("'", "''", (string) $value) . "'";
        }, $sql);
    }
    public function query($sql) { $this->queries[] = $sql; return 1; }
    public function get_var($sql) {
        $this->reads[] = $sql;
        if (preg_match('/SHOW\s+TABLES\s+LIKE\s+\'([^\']+)\'/i', $sql, $match)) {
            $name = stripslashes($match[1]);
            return isset($this->tables[$name]) ? $name : null;
        }
        throw new RuntimeException('Unexpected scalar query: ' . $sql);
    }
    public function get_results($sql, $format = ARRAY_A) {
        $this->reads[] = $sql;
        $result = lctp_test_library_stats_query($sql, $this->prefix, $this->legacy, $this->hourly);
        // Simulate requests arriving immediately after a SELECT takes its snapshot.
        $this->hourly = array_merge($this->hourly, $this->hourly_read_extra);
        $this->hourly_read_extra = array();
        return $result;
    }
}

function period_fixture($date, $status, $count, $utc, $hour = null) {
    $row = array('request_date' => $date, 'status_code' => $status, 'request_count' => $count, 'last_called_at' => $utc);
    if ($hour !== null) { $row['request_hour'] = $hour; }
    return $row;
}
function period_index($rows, $key) {
    $indexed = array(); foreach ($rows as $row) { $indexed[$row[$key]] = $row; } return $indexed;
}

$GLOBALS['wpdb'] = new PeriodDatabase();
try {
    require dirname(__DIR__) . '/wordpress/lctp-library-stats.php';
    $database = $GLOBALS['wpdb'];
    $database->legacy = array(
        period_fixture('2025-01-01', 200, 100, '2025-01-01 00:00:00'),
        period_fixture('2026-11-09', 200, 2, '2026-11-09 08:00:00'),
        period_fixture('2026-11-09', 503, 1, '2026-11-09 09:00:00'),
        period_fixture('2026-11-10', 200, 4, '2026-11-10 10:00:00'),
        period_fixture('2026-11-10', 304, 3, '2026-11-10 10:00:00'),
        period_fixture('2026-11-11', 503, 2, '2026-11-10 16:00:00'),
    );
    $legacy_before = $database->legacy;
    period_check(lctp_library_stats_install() === true, 'The schema-1 upgrade must install hourly storage.');
    period_check(get_option('lctp_library_stats_schema') === '2', 'Hourly storage upgrades schema to version 2.');
    period_check(get_option('lctp_library_stats_enabled_at') === '2026-11-10 10:00:00', 'An upgrade must preserve the original counting start time.');
    period_check(is_string(get_option('lctp_library_stats_hourly_enabled_at')) && get_option('lctp_library_stats_hourly_enabled_at') !== '', 'The hourly start time must be tracked separately.');
    $ddl = implode("\n", $GLOBALS['period_ddl']);
    period_check(strpos($ddl, 'period_lctp_library_api_hourly') !== false, 'Hourly storage must honor the configured WordPress table prefix.');
    period_check(preg_match('/PRIMARY\s+KEY\s*\(\s*request_date\s*,\s*request_hour\s*,\s*status_code\s*\)/i', $ddl) === 1, 'Date/hour/status must identify one atomic hourly counter.');
    $ddl_count = count($GLOBALS['period_ddl']);
    lctp_library_stats_install();
    period_check(count($GLOBALS['period_ddl']) === $ddl_count, 'An already-upgraded request must not repeat migration.');

    $database->queries = array();
    lctp_library_stats_record(200);
    $GLOBALS['period_now'] = new DateTimeImmutable('2026-11-10 23:59:59', new DateTimeZone('Asia/Shanghai'));
    lctp_library_stats_record(304);
    period_check(count($database->queries) === 2, 'Each observed call needs exactly one write after upgrade.');
    foreach ($database->queries as $sql) {
        period_check(preg_match('/INSERT\s+INTO\s+`?period_lctp_library_api_hourly`?/i', $sql) === 1, 'New calls must write only the hourly table.');
        period_check(stripos($sql, 'ON DUPLICATE KEY UPDATE') !== false, 'Hourly increments must remain atomic.');
        period_check(strpos($sql, 'period_lctp_library_api_daily') === false, 'New requests must not double-write legacy counters.');
    }
    period_check(preg_match('/VALUES\s*\(\s*\'2026-11-11\'\s*,\s*0\s*,/i', $database->queries[0]) === 1, '00:30 local belongs to hour 0 of the new local date.');
    period_check(strpos($database->queries[0], "'2026-11-10 16:30:00'") !== false, 'The hour-0 call timestamp must remain UTC.');
    period_check(preg_match('/VALUES\s*\(\s*\'2026-11-10\'\s*,\s*23\s*,/i', $database->queries[1]) === 1, '23:59 local belongs to hour 23 of the previous local date.');
    period_check(strpos($database->queries[1], "'2026-11-10 15:59:59'") !== false, 'The hour-23 call timestamp must remain UTC.');
    period_check($database->legacy === $legacy_before, 'Migration and hourly writes must preserve historical daily rows.');
    $GLOBALS['period_now'] = new DateTimeImmutable('2026-11-11 00:30:00', new DateTimeZone('Asia/Shanghai'));
    $database->hourly = array(
        period_fixture('2026-11-10', 200, 5, '2026-11-09 16:01:00', 0),
        period_fixture('2026-11-10', 304, 7, '2026-11-10 15:01:00', 23),
        period_fixture('2026-11-10', 503, 1, '2026-11-10 15:02:00', 23),
        period_fixture('2026-11-11', 200, 11, '2026-11-10 16:28:00', 0),
        period_fixture('2026-11-11', 503, 2, '2026-11-10 16:29:00', 0),
        period_fixture('2026-11-11', 302, 3, '2026-11-10 16:30:00', 0),
    );

    $selected = lctp_library_stats_read('2026-11-10', '2026-11-11');
    period_check(!is_wp_error($selected), 'A valid inclusive custom range must be readable.');
    period_check($selected['summary'] === array('total' => 141, 'today' => 18, 'last_7_days' => 41, 'last_30_days' => 41), 'Selecting dates must preserve existing all-time/rolling summary semantics.');
    period_check($selected['range'] === array('start' => '2026-11-10', 'end' => '2026-11-11', 'total' => 38, 'success' => 20, 'not_modified' => 10, 'errors' => 5, 'legacy_requests' => 9), 'The selected range must add both stores once, expose legacy coverage and classify statuses correctly.');
    period_check(count($selected['daily']) === 2, 'Custom daily output must contain exactly the selected dates.');
    $days = period_index($selected['daily'], 'date');
    period_check($days['2026-11-10'] === array('date' => '2026-11-10', 'total' => 20, 'success' => 9, 'not_modified' => 10, 'errors' => 1), 'The upgrade day must combine its legacy and hourly requests without losing either.');
    period_check($days['2026-11-11']['total'] === 18 && $days['2026-11-11']['errors'] === 4, 'Today must include legacy rows if upgrading during the same local date.');
    period_check(count($selected['hourly']) === 24, 'Hourly distribution must always provide every hour.');
    $hours = period_index($selected['hourly'], 'hour');
    period_check(array_keys($hours) === range(0, 23), 'Hour labels must be unique integer values in clock order.');
    period_check($hours[0] === array('hour' => 0, 'total' => 21, 'success' => 16, 'not_modified' => 0, 'errors' => 2), 'Hour 0 must aggregate the selected dates in the site timezone.');
    period_check($hours[23] === array('hour' => 23, 'total' => 8, 'success' => 0, 'not_modified' => 7, 'errors' => 1), 'Hour 23 must distinguish unchanged checks from errors.');
    period_check($hours[12] === array('hour' => 12, 'total' => 0, 'success' => 0, 'not_modified' => 0, 'errors' => 0), 'Hours without calls must contain integer zero values.');
    period_check(array_sum(array_column($hours, 'total')) + $selected['range']['legacy_requests'] === $selected['range']['total'], 'Legacy counts must explain exactly the difference between daily and hourly coverage.');
    period_check($selected['last_called_at'] === '2026-11-10 16:30:00', 'The latest call must be selected across both stores and remain UTC.');
    period_check($selected['hourly_enabled_at'] === get_option('lctp_library_stats_hourly_enabled_at'), 'Readers must disclose when hourly coverage began.');

    $database->hourly_read_extra = array(period_fixture('2026-11-11', 201, 50, '2026-11-10 16:30:01', 0));
    $concurrent = lctp_library_stats_read('2026-11-10', '2026-11-11');
    period_check($concurrent === $selected, 'One report must use one snapshot for summary, daily and hourly counts.');
    $after = lctp_library_stats_read('2026-11-10', '2026-11-11');
    period_check($after['summary']['total'] === 191 && $after['range']['total'] === 88
        && array_sum(array_column($after['hourly'], 'total')) + $after['range']['legacy_requests'] === 88,
        'A later report must include concurrent calls consistently throughout.');
    array_pop($database->hourly);

    $legacy_only = lctp_library_stats_read('2026-11-09', '2026-11-09');
    period_check($legacy_only['range']['total'] === 3 && $legacy_only['range']['legacy_requests'] === 3, 'A legacy-only day must remain visible after migration.');
    period_check(array_sum(array_column($legacy_only['hourly'], 'total')) === 0, 'A legacy-only day must not invent hourly distribution.');
    $one_day = lctp_library_stats_read('2026-11-11', '2026-11-11');
    period_check($one_day['range']['total'] === 18 && count($one_day['daily']) === 1 && $one_day['hourly'][23]['total'] === 0, 'Same-day inclusive filtering must exclude the neighboring date/hour.');
    $empty = lctp_library_stats_read('2026-10-01', '2026-10-03');
    period_check($empty['range']['total'] === 0 && count($empty['daily']) === 3 && count($empty['hourly']) === 24, 'A valid empty period must keep its full zero-filled calendar and clock.');
    $default = lctp_library_stats_read();
    period_check($default['range']['start'] === '2026-10-13' && $default['range']['end'] === '2026-11-11' && count($default['daily']) === 30, 'Omitted dates must retain the existing inclusive 30-day view.');
    $GLOBALS['period_clock'] = array(
        new DateTimeImmutable('2026-11-10 23:59:59', wp_timezone()),
        new DateTimeImmutable('2026-11-11 00:00:00', wp_timezone()),
    );
    $at_midnight = lctp_library_stats_read();
    period_check($at_midnight['range']['end'] === '2026-11-10' && $at_midnight['summary']['today'] === 20,
        'A report crossing local midnight must use one site date for both the selected range and the summary.');
    unset($GLOBALS['period_clock']);
    $blank = lctp_library_stats_read('', '');
    period_check($blank['range'] === $default['range'], 'Empty date inputs must use the same default period.');
    $max_start = current_datetime()->modify('-365 days')->format('Y-m-d');
    $maximum = lctp_library_stats_read($max_start, '2026-11-11');
    period_check(!is_wp_error($maximum) && count($maximum['daily']) === 366, 'The inclusive maximum of 366 dates must be accepted.');
    $leap = lctp_library_stats_read('2024-02-29', '2024-02-29');
    period_check(!is_wp_error($leap) && count($leap['daily']) === 1, 'A real leap date must pass calendar validation.');

    foreach (array(
        array('2026-02-29', '2026-03-01'), array('2026-11-31', '2026-11-31'),
        array('2026-1-01', '2026-01-02'), array('2026-11-10 ', '2026-11-11'),
        array('2026-11-10T00:00:00', '2026-11-11'), array('2026-11-11', '2026-11-10'),
        array('2026-11-12', '2026-11-12'), array(current_datetime()->modify('-366 days')->format('Y-m-d'), '2026-11-11'),
        array('2026-11-10', null), array(null, '2026-11-11'), array('', '2026-11-11'), array('', null), array(null, ''),
        array(array('2026-11-10'), '2026-11-11'), array('2026-11-10', new stdClass()),
        array("2026-11-10' OR 1=1 --", '2026-11-11'),
    ) as $invalid) {
        $reads_before = count($database->reads);
        $failure = lctp_library_stats_read($invalid[0], $invalid[1]);
        period_check(is_wp_error($failure) && ($failure->get_error_data()['status'] ?? null) === 400, 'Invalid dates/ranges must fail explicitly as a client error.');
        period_check(count($database->reads) === $reads_before, 'Rejected periods must not execute statistics reads.');
    }
    $GLOBALS['period_now'] = current_datetime()->setTimezone(new DateTimeZone('America/Sao_Paulo'));
    $over_limit = lctp_library_stats_read('2018-11-04', '2019-11-05');
    period_check(is_wp_error($over_limit), 'A DST jump at local midnight must not shorten 367 calendar dates into the allowed range.');
    $valid_dst = lctp_library_stats_read('2018-11-04', '2019-11-04');
    period_check(!is_wp_error($valid_dst) && count($valid_dst['daily']) === 366, 'Calendar ranges must include both endpoints across midnight DST.');
    $GLOBALS['period_now'] = current_datetime()->setTimezone(new DateTimeZone('Asia/Shanghai'));

    $response = lctp_library_stats_response(new PeriodRequest(array('start' => '2026-11-10', 'end' => '2026-11-11')));
    period_check($response->get_status() === 200 && $response->get_data()['range'] === $selected['range'], 'The REST route must apply its start/end parameters.');
    $response = lctp_library_stats_response(new PeriodRequest(array('start' => '2026-11-12', 'end' => '2026-11-12')));
    period_check($response->get_status() === 400, 'An invalid REST period must remain HTTP 400 rather than a server failure.');
    $headers = array_change_key_case($response->get_headers(), CASE_LOWER);
    period_check(strpos($headers['cache-control'] ?? '', 'no-store') !== false, 'Invalid range responses must remain private and uncacheable.');
    period_check($database->legacy === $legacy_before, 'Reading custom/default periods must preserve all legacy counters.');
    echo "WordPress library statistics period/hour fixtures passed.\n";
} finally {
    unlink(ABSPATH . 'wp-admin/includes/upgrade.php');
    rmdir(ABSPATH . 'wp-admin/includes');
    rmdir(ABSPATH . 'wp-admin');
    rmdir(ABSPATH);
}
