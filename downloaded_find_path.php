<?php
    echo "Searching for Api.php...\n";
    $dir = new RecursiveDirectoryIterator(__DIR__ . "/wp-content/plugins/fs-poster");
    foreach (new RecursiveIteratorIterator($dir) as $file) {
        if ($file->getFilename() == "Api.php") {
            echo $file->getRealPath() . "\n";
        }
    }
    