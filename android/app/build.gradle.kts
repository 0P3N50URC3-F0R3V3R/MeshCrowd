import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Local sideloading signing key only, never committed (see .gitignore). Signing is skipped if the
// file isn't present, so a fresh checkout still builds an (unsigned) release and a debug APK.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}
val hasReleaseSigning = keystorePropsFile.exists()

android {
    namespace = "com.meshcrowd.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.meshcrowd.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 15
        versionName = "3.12"
        // Pure Kotlin + WebView: no native libraries, so no ABI filters, one universal APK.
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("org.unifiedpush.android:connector:3.0.10")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}

// Copies the built APK(s) into AndroidReleases/ at the repo root: the only place a finished APK lives.
tasks.register<Copy>("collectApk") {
    dependsOn("assembleRelease")
    from(layout.buildDirectory.dir("outputs/apk/release")) {
        include("*.apk")
        rename { "MeshCrowd-${android.defaultConfig.versionName}.apk" }
    }
    into(rootProject.file("../AndroidReleases"))
}
