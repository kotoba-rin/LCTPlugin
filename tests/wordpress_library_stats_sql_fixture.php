<?php
/** Run the actual report SELECT against legacy and hourly rows, without a WordPress installation. */
function lctp_test_library_stats_query($sql, $prefix, $daily, $hourly) {
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, true);
    foreach (array('daily' => $daily, 'hourly' => $hourly) as $period => $rows) {
        $table = $prefix . 'lctp_library_api_' . $period;
        $has_hour = $period === 'hourly';
        $db->exec("CREATE TABLE $table (request_date TEXT,status_code INTEGER,request_count INTEGER,last_called_at TEXT"
            . ($has_hour ? ',request_hour INTEGER)' : ')'));
        $values = ':request_date,:status_code,:request_count,:last_called_at' . ($has_hour ? ',:request_hour' : '');
        $insert = $db->prepare("INSERT INTO $table VALUES ($values)");
        foreach ($rows as $row) {
            $insert->execute($row);
        }
    }
    return $db->query($sql)->fetchAll(PDO::FETCH_ASSOC);
}
